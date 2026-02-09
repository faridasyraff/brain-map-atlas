/**
 * Brain API client
 * Handles all communication with FastAPI backend
 */

const API_BASE = 'http://127.0.0.1:8000';

export const brainApi = {
  /**
   * Get region info by MBA structure ID
   */
  async getRegionById(mbaId) {
    try {
      const response = await fetch(`${API_BASE}/regions/${mbaId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('Error fetching region by ID:', error);
      return null;
    }
  },

  /**
   * Get region by RGB color (from label PNG pixel)
   * Returns region info or null if not found / background
   */
  async getRegionByRGB(r, g, b) {
    try {
      const response = await fetch(
        `${API_BASE}/regions/by_rgb/lookup?r=${r}&g=${g}&b=${b}`
      );
      if (!response.ok) {
        // 404 = background or no match
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching region by RGB:', error);
      return null;
    }
  },

  /**
   * Get region by combined annotation id (r<<16 | g<<8 | b)
   */
  async getRegionByAnnotation(annotationId) {
    try {
      const response = await fetch(`${API_BASE}/regions/by_annotation/${annotationId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('Error fetching region by annotation:', error);
      return null;
    }
  },

  /**
   * Search regions by text (cached)
   */
  async searchRegions(query, limit = 20) {
    try {
      const response = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`
      );
      if (!response.ok) return [];
      return await response.json();
    } catch (error) {
      console.error('Error searching regions:', error);
      return [];
    }
  },

  /**
   * Check API health
   */
  async health() {
    try {
      const response = await fetch(`${API_BASE}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
};
