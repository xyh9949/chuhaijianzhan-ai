import type { MediaItem, PageItem, Product, SiteSettings, SiteTheme, StudioState } from '../lib/types';

export type ProductRecord = Product & { seoTitle?: string; seoDescription?: string; specifications?: { label: string; value: string }[] };
export type DraftContent = Pick<StudioState, 'pages' | 'media' | 'theme' | 'settings' | 'editorData' | 'sharedBlocks' | 'siteLayout' | 'customCode' | 'contentModels' | 'contentEntries' | 'taxonomies' | 'redirects' | 'forms' | 'pageTemplates'> & { products: ProductRecord[] };
export type PublicSettings = Pick<SiteSettings, 'name' | 'description' | 'email' | 'language' | 'publicUrl' | 'locales' | 'discovery'>;
export interface SiteSnapshot {
  releaseId?: string;
  urlState?:Record<string,{hash:string;modified:string}>;
  schemaVersion: number;
  pages: PageItem[];
  editorData: Record<string, unknown>;
  products: ProductRecord[];
  media: MediaItem[];
  theme: SiteTheme;
  settings: PublicSettings;
  sharedBlocks?: StudioState['sharedBlocks'];
  siteLayout?: StudioState['siteLayout'];
  taxonomies?: StudioState['taxonomies'];
  redirects?: StudioState['redirects'];
  forms?: StudioState['forms'];
  pageTemplates?: StudioState['pageTemplates'];
  publicRedirects?: import('../lib/types').PublishedRedirect[];
  customCode?: StudioState['customCode'];
  contentModels?: StudioState['contentModels'];
  contentEntries?: StudioState['contentEntries'];
}
export interface PublicationSelection {
  expectedRevision: number;
  baseReleaseId: string | null;
  title?: string;
  pageIds: string[];
  removePageIds?: string[];
  productIds?: string[];
  removeProductIds?: string[];
  includeTheme: boolean;
  includeSettings: boolean;
  sharedBlockIds?: string[];
  removeSharedBlockIds?: string[];
  includeRedirects?: boolean;
  includeForms?: boolean;
  includeTemplates?: boolean;
  includeCatalog?: boolean;
  includeLayout?: boolean;
  includeCode?: boolean;
  contentModelIds?: string[];
  removeContentModelIds?: string[];
  contentEntryIds?: string[];
  removeContentEntryIds?: string[];
}
export type ActorIdentity = { id: string; name: string };
