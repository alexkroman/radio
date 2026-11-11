// icecast-metadata-js ships no types; just what test/helpers.ts uses.
declare module "icecast-metadata-js" {
  export class IcecastMetadataReader {
    constructor(options: {
      icyMetaInt: number;
      onMetadata: (value: { metadata: { StreamTitle?: string } }) => void;
    });
    readAll(chunk: Uint8Array): void;
  }
}
