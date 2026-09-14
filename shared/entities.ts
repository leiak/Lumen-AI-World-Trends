export type EntityType = 'person' | 'organization' | 'country' | 'location' | 'topic' | 'event';

export interface NamedEntity {
  name: string;
  nameEn?: string;
  type: EntityType;
  lang: 'zh' | 'en';
}
