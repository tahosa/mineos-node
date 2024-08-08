export const DIRS = {
  servers: 'servers',
  backup: 'backup',
  archive: 'archive',
  profiles: 'profiles',
  import: 'import',
};

type ServerPropertiesKeys =
  | 'server-port'
  | 'max-players'
  | 'level-seed'
  | 'gamemode'
  | 'difficulty'
  | 'level-type'
  | 'level-name'
  | 'max-build-height'
  | 'generate-structures'
  | 'generator-settings'
  | 'server-ip'
  | 'enable-query';

export type ServerProperties = {
  [key in ServerPropertiesKeys]?: string | number;
} & { [key: string]: string | number };

export const SP_DEFAULTS: ServerProperties = {
  'server-port': 25565,
  'max-players': 20,
  'level-seed': '',
  gamemode: 0,
  difficulty: 1,
  'level-type': 'DEFAULT',
  'level-name': 'world',
  'max-build-height': 256,
  'generate-structures': 'true',
  'generator-settings': '',
  'server-ip': '0.0.0.0',
  'enable-query': 'false',
};

export type JavaArgs =
  | 'java_binary'
  | 'java_xmx'
  | 'java_xms'
  | 'jarfile'
  | 'jar_args'
  | 'java_tweaks';

export type ServerConfig = {
  java: { [key in JavaArgs]: string };
  onreboot: {
    start: boolean;
  };
  minecraft: {
    profile?: string;
    broadcast?: boolean;
    unconventional?: boolean;
    commit_interval?: number;
  };
};

export type CronActions =
  | 'start'
  | 'stop'
  | 'restart'
  | 'backup'
  | 'archive'
  | 'stuff';

export type CronTask = {
  command: CronActions;
  source: string; // Cron string like 10 */4 * * *
  msg?: string;
  enabled?: boolean;
};

export type CronConfig = {
  [key: string]: CronTask;
};
