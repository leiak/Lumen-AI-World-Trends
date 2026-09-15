export interface CollectSettings {
  enabledSources: string[];
  autoEnabled: boolean;
  intervalMinutes: number;
}

export interface SourceInfo {
  id: string;
  name: string;
  lang: string;
  kind: string;
}

export interface SettingsView {
  settings: CollectSettings;
  allSources: SourceInfo[];
}