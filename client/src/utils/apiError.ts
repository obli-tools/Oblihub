/** The server's error message (`{ error }` body) when there is one, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}
