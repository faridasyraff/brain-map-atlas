/** Where the React atlas is served. (Stage 7 moves it to /app.) */
export const ATLAS_PATH = '/next';

/** A link that opens the atlas on a region group, e.g. the hippocampal formation. */
export const atlasGroupLink = (group: string) => `${ATLAS_PATH}?${new URLSearchParams({ group }).toString()}`;
