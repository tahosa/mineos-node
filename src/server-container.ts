import Socket from 'socket.io';

export class ServerContainer {
  //instance: Mineos;
  nsp: Socket;
  tails = {};
  notices: string[] = [];
  cron = {};
  intervals = {};
  HEARTBEAT_INTERVAL_MS = 5000;
  COMMIT_INTERVAL_MIN = null;

  constructor() {}
}
