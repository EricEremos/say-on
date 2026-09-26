import argparse
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import json
from rehearsal_concurrency import verify_concurrency

ROOT = Path(__file__).resolve().parents[1]
TARGET = "20260908090000_version_balance_launch_catalog.sql"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--profile",
        choices=("public",),
        default="public",
        help="Migration profile to apply; public is the clean-release default.",
    )
    profile = parser.parse_args().profile
    migration_directory = ROOT / "supabase" / profile / "migrations"
    test_directory = ROOT / "supabase" / profile / "tests"
    test_files = [test_directory / "balance_catalog_version.test.sql"]
    test_files.append(test_directory / "room_lifecycle_expiry.test.sql")
    test_files.append(test_directory / "balance_catalog_v2.test.sql")
    test_files.append(test_directory / "realtime_publication.test.sql")
    test_files.append(test_directory / "room_passwords.test.sql")
    # The room lifecycle again, now on the password-aware join and create functions.
    test_files.append(test_directory / "room_lifecycle_expiry.test.sql")
    binaries = {name: shutil.which(name) for name in ("initdb", "pg_ctl", "psql")}
    if not all(binaries.values()):
        raise SystemExit("Local PostgreSQL initdb, pg_ctl and psql are required.")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    if not (environment.get("LC_ALL") or environment.get("LANG")):
        # Without a locale the macOS postmaster exits: "became multithreaded during startup".
        environment = {**environment, "LC_ALL": "C.UTF-8"}
    with tempfile.TemporaryDirectory(prefix="roundleaf-pg-", dir="/tmp") as temporary:
        root = Path(temporary)
        data = root / "data"
        socket = root / "socket"
        socket.mkdir()

        def run(name, *arguments, sql=None):
            result = subprocess.run(
                [binaries[name], *map(str, arguments)], input=sql, text=True,
                capture_output=True, env=environment, timeout=60,
            )
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            return result.stdout

        def execute(sql):
            return run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", socket,
                       "-p", "55439", "-U", "postgres", "-d", "postgres", sql=sql)

        run("initdb", "-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8")
        run("pg_ctl", "-D", data, "-l", root / "server.log", "-o",
            f"-k {socket} -p 55439 -c listen_addresses='' -c wal_level=logical", "-w", "start")
        try:
            execute("""
                create role anon nologin;
                create role authenticated nologin;
                create role service_role nologin bypassrls;
                create schema auth;
                create schema extensions;
                create table auth.users (id uuid primary key);
                create function auth.uid() returns uuid language sql stable as
                $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
                grant usage on schema auth to anon, authenticated, service_role;
                -- Hosted Supabase grants every new public table, function and sequence to the
                -- client roles by default; model that so privilege tests see what production sees.
                grant usage on schema public to anon, authenticated, service_role;
                alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
                alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
                alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
                create publication supabase_realtime;
            """)
            count = 0
            for migration in sorted(migration_directory.glob("*.sql")):
                if migration.name >= TARGET:
                    break
                sql = migration.read_text()
                try:
                    execute(sql)
                except RuntimeError as error:
                    raise RuntimeError(f"Migration {migration.name}: {error}") from error
                count += 1
            results = [
                run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", socket,
                    "-p", "55439", "-U", "postgres", "-d", "postgres", "-f", test_file)
                for test_file in test_files
            ]
            print(f"PASS: {profile} profile applied {count} prerequisite migrations and versioned catalog regression.")
            print("Scope: local auth.uid fixture; cron scheduling excluded; no Supabase network/Realtime transport.")
            print("\n".join(result.strip() for result in results))
            races = verify_concurrency(execute)
            report = ROOT / "docs/design-review/say-on-db-concurrency-qa.json"
            report.write_text(json.dumps(races, indent=2) + "\n")
            print("PASS: three repeated three-connection card/vote races; " + str(report.relative_to(ROOT)))
        finally:
            run("pg_ctl", "-D", data, "-m", "fast", "-w", "stop")


if __name__ == "__main__":
    main()
