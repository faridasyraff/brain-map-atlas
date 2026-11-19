/** Where the atlas is served (backend/App.py). */
export const ATLAS_PATH = '/app';

/** A link that opens the atlas on a region group, e.g. the hippocampal formation. */
export const atlasGroupLink = (group: string) => `${ATLAS_PATH}?${new URLSearchParams({ group }).toString()}`;
