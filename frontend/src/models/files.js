import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const StorageFiles = {
  /**
   * Download a file from the server
   * @param {string} storageFilename - The filename to download
   * @returns {Promise<Blob>}
   */
  download: async function (storageFilename) {
    const response = await fetch(
      `${API_BASE}/agent-skills/generated-files/${encodeURIComponent(
        storageFilename
      )}`,
      { headers: baseHeaders() }
    );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Your session has expired or you do not have permission to download this file. Please sign in again."
      );
    if (response.status === 404)
      throw new Error(
        "This file is no longer available or you do not have access to it."
      );
    if (!response.ok)
      throw new Error(
        `Failed to download file (HTTP ${response.status}). Please try again.`
      );
    return response.blob();
  },

  /**
   * Fetch a generated image as a Blob. The serve endpoint is auth-protected, so
   * we cannot use the URL directly as an <img> src - callers create an object URL.
   * @param {string} storageFilename - The image filename to fetch
   * @returns {Promise<Blob|null>}
   */
  image: async function (storageFilename) {
    return await fetch(
      `${API_BASE}/image-generation/generated-images/${encodeURIComponent(storageFilename)}`,
      { headers: baseHeaders() }
    )
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch image");
        return res.blob();
      })
      .catch((e) => {
        console.error("Image fetch failed:", e);
        return null;
      });
  },
};

export default StorageFiles;
