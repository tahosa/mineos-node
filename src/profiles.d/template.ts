type ProgressState = {
  percent: string;
  size: {
    total: number;
    transferred: number;
  };
};

export default class Profile {
  id: string;
  filename: string;
  url: string;
  time?: number;
  releaseTime?: number;
  type?: 'release' | 'snapshot' | 'old_version';
  group?: string;
  webui_desc?: string;
  weight: number = 0;
  downloaded: boolean = false;
  version?: string | number;
  release_version?: string;
  progress?: ProgressState;

  constructor({ id, filename, url }: { id: string; filename: string; url: string }) {
    this.id = id;
    this.filename = filename;
    this.url = url;
  }
}

type RequestType = 'json' | 'text';

export type Collection = {
  name: string;
  handler: (profile_dir: string, body?: any) => Promise<Profile[]>;
  postdownload?: (profile_dir: string, dest_filepath: string) => Promise<void>;
  request_args?: {
    url: string;
    type: RequestType;
  };
};
