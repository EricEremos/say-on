export const realtimeStatusProblem = (status: string, subject: string): string | null => {
  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
    return `${subject} 실시간 연결이 끊겼어요. 인터넷 연결을 확인해 주세요.`;
  }
  return null;
};
