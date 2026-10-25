/** One server from the public MCP registry, trimmed to what the Discover tab shows. */
export interface RegistryServer {
  /** Reverse-DNS name, for example `io.github.user/weather`. */
  name: string;
  title?: string;
  description: string;
  version: string;
  /** Source repository, only when the registry gives an http(s) address. */
  repository?: { url: string };
  /** Hosted endpoints: the transport type and the address (it may hold `{variables}`). */
  remotes: { type: string; url: string }[];
  /** Local packages: the package registry (npm, pypi, oci, ...) and the transport type. */
  packages: { registryType: string; transport: string }[];
}

export interface RegistrySearchResult {
  servers: RegistryServer[];
  /** Pass back as `cursor` to get the next page. Absent on the last page. */
  nextCursor?: string;
}
