/**
 * Brain Regions API - calls to Allen Brain Atlas
 */

export const regionsApi = {
  async getRegionById(regionId) {
    const url = `https://api.brain-map.org/api/v2/data/Structure/${regionId}.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch region: ${response.status}`);
    return response.json();
  },

  async searchRegions(query) {
    const url = `https://api.brain-map.org/api/v2/data/query.json?criteria=[name$il'${query}']&model=Structure`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Search failed: ${response.status}`);
    return response.json();
  },
};
