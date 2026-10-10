import { logger } from '../utils/logger';

interface RegistryAuth {
  username: string;
  password: string;
  serveraddress?: string;
}

/**
 * Parse a Docker image reference into its components.
 * Examples:
 *   "nginx"                          → { registry: "registry-1.docker.io", namespace: "library", repo: "nginx" }
 *   "myorg/app-server"               → { registry: "registry-1.docker.io", namespace: "myorg", repo: "app-server" }
 *   "ghcr.io/user/repo"             → { registry: "ghcr.io", namespace: "user", repo: "repo" }
 *   "registry.example.com/ns/repo"  → { registry: "registry.example.com", namespace: "ns", repo: "repo" }
 */
function parseImageRef(image: string): { registry: string; namespace: string; repo: string; fullName: string } {
  const parts = image.split('/');

  if (parts.length === 1) {
    // Official Docker Hub image (e.g. "nginx")
    return { registry: 'registry-1.docker.io', namespace: 'library', repo: parts[0], fullName: `library/${parts[0]}` };
  }

  if (parts.length === 2) {
    // Could be Docker Hub user/repo or a registry with a repo
    // If first part contains a dot or colon, it's a registry
    if (parts[0].includes('.') || parts[0].includes(':')) {
      return { registry: parts[0], namespace: '', repo: parts[1], fullName: parts[1] };
    }
    // Docker Hub user/repo
    return { registry: 'registry-1.docker.io', namespace: parts[0], repo: parts[1], fullName: `${parts[0]}/${parts[1]}` };
  }

  // 3+ parts: first is registry
  const registry = parts[0];
  const rest = parts.slice(1).join('/');
  const nsRepo = rest.split('/');
  const namespace = nsRepo.slice(0, -1).join('/');
  const repo = nsRepo[nsRepo.length - 1];
  return { registry, namespace, repo, fullName: rest };
}

/**
 * Get a Docker Hub bearer token for pulling manifests.
 *
 * When DOCKERHUB_USERNAME + DOCKERHUB_TOKEN are configured, we authenticate the token request
 * with HTTP Basic auth. Docker Hub then issues a token tied to the account, which counts
 * against the higher authenticated rate limit (200/6h free, unlimited on paid plans) instead
 * of the shared 100/6h-per-IP anonymous bucket. Anonymous fallback is preserved when no creds
 * are set, so existing installs keep working unchanged.
 */
async function getDockerHubToken(repository: string): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`;
  const headers: Record<string, string> = {};
  const { config } = await import('../config');
  if (config.dockerHubUsername && config.dockerHubToken) {
    const basic = Buffer.from(`${config.dockerHubUsername}:${config.dockerHubToken}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // 401 here usually means bad credentials — surface that clearly rather than a generic failure.
    throw new Error(`Docker Hub token request failed: ${res.status}${res.status === 401 ? ' (check DOCKERHUB_USERNAME / DOCKERHUB_TOKEN)' : ''}`);
  }
  const data = await res.json() as { token: string };
  return data.token;
}

export const registryService = {
  /**
   * Get the remote digest for an image:tag from its registry.
   * Uses HEAD request on the manifest endpoint to get Docker-Content-Digest.
   */
  async getRemoteDigest(image: string, tag: string): Promise<string | null> {
    try {
      const ref = parseImageRef(image);

      let authHeader = '';

      if (ref.registry === 'registry-1.docker.io') {
        // Docker Hub: needs bearer token
        const token = await getDockerHubToken(ref.fullName);
        authHeader = `Bearer ${token}`;
      }
      // For other registries, auth would need stored credentials

      const manifestUrl = `https://${ref.registry}/v2/${ref.fullName}/manifests/${tag}`;

      const res = await fetch(manifestUrl, {
        method: 'HEAD',
        headers: {
          'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
          ...(authHeader ? { 'Authorization': authHeader } : {}),
        },
      });

      if (!res.ok) {
        // Try GET if HEAD fails (some registries don't support HEAD)
        const getRes = await fetch(manifestUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
            ...(authHeader ? { 'Authorization': authHeader } : {}),
          },
        });
        if (!getRes.ok) {
          logger.warn({ image, tag, status: getRes.status }, 'Registry manifest request failed');
          return null;
        }
        return getRes.headers.get('docker-content-digest');
      }

      return res.headers.get('docker-content-digest');
    } catch (err) {
      logger.warn({ image, tag, err }, 'Failed to get remote digest');
      return null;
    }
  },

  /**
   * Check if a newer version is available for an image.
   * Compares the remote digest against the FULL set of locally-known digests
   * (Docker may accumulate several for the same image when a registry re-manifests a tag).
   * Accepts `currentDigests` as either a single digest (legacy) or a full list.
   */
  async checkForUpdate(image: string, tag: string, currentDigests: string | string[] | null): Promise<{ hasUpdate: boolean; remoteDigest: string | null }> {
    const remoteDigest = await this.getRemoteDigest(image, tag);

    if (!remoteDigest) {
      return { hasUpdate: false, remoteDigest: null };
    }

    const localList = Array.isArray(currentDigests)
      ? currentDigests
      : currentDigests ? [currentDigests] : [];

    if (localList.length === 0) {
      // No local digest known — can't compare, treat as unknown
      return { hasUpdate: false, remoteDigest };
    }

    const hasUpdate = !localList.includes(remoteDigest);
    return { hasUpdate, remoteDigest };
  },

  /** Parse an image reference for display/debugging */
  parseImageRef,
};
