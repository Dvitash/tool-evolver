import type { ProtocolMessage } from "@tool-evolver/protocol";

export interface ObserverService {
  recordEvent(message: ProtocolMessage): void;
  getEventCount(): number;
}

export function createObserver(): ObserverService {
  const events: ProtocolMessage[] = [];
  return {
    recordEvent(msg) {
      events.push(msg);
    },
    getEventCount() {
      return events.length;
    },
  };
}
