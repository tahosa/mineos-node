export default class profile {
  id?: string;
  time?: number;
  releaseTime?: number;
  type?: 'release' | 'snapshot' | 'old_version';
  group?: string;
  webui_desc?: string;
  weight: number = 0;
  downloaded: boolean = false;
  filename?: string;
  version?: string | number;
  release_version?: string;
  url?: string;

  constructor() {}
}

export type collection = {
  name: string;
  handler: (profile_dir: string, body?: any) => Promise<profile[]>;
  postdownload?: (profile_dir: string, dest_filepath: string) => Promise<void>;
  request_args?: {
    url: string;
    type: 'json' | 'text';
  };
};
