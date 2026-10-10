/**
 * Validation of engine values that end up in `~/.ssh/config` and `DOCKER_HOST`.
 *
 * Both are written verbatim: a newline in a host or SSH user would inject ssh_config directives
 * such as ProxyCommand (arbitrary command execution in the server container), and spaces or shell
 * metacharacters would split or alter the DOCKER_HOST URL.
 */

export const ENGINE_HOST_RE = /^[A-Za-z0-9.:\-\[\]]+$/;
export const SSH_USER_RE = /^[a-z_][a-z0-9_.-]*$/i;

const ENGINE_HOST_MAX = 253;
const SSH_USER_MAX = 64;

/** Error message, or null when valid. Absent values pass: whether a host is required is checked elsewhere. */
// The pattern is tested on the RAW value, not the trimmed one: the engine service stores what it
// receives, so a leading or trailing newline must be rejected rather than validated away.

export function validateEngineHost(host: string | null | undefined): string | null {
  if (host == null || host.trim() === '') return null;
  if (host.length > ENGINE_HOST_MAX || !ENGINE_HOST_RE.test(host)) {
    return `Invalid host "${host.slice(0, 40)}": use a hostname or IP address (letters, digits, dot, dash, colon, brackets).`;
  }
  return null;
}

export function validateSshUser(user: string | null | undefined): string | null {
  if (user == null || user.trim() === '') return null;
  if (user.length > SSH_USER_MAX || !SSH_USER_RE.test(user)) {
    return 'Invalid SSH user: letters, digits, dot, dash and underscore only, not starting with a digit, dot or dash.';
  }
  return null;
}
