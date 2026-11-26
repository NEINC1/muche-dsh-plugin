/** Resolve the host-signed login URL used to seed the isolated Electron session. */
export function getAuthenticatedEntryUrl(ctx) {
  const baseUrl = ctx.webServer.getOrigin()
  const entries = []
  ctx.emit(ctx.webServer, 'webserver/entry-url', baseUrl, entries)
  const matches = entries.filter((candidate) => candidate?.label === 'dsh web' && typeof candidate.url === 'string')
  if (matches.length !== 1) throw new Error('DSH web authentication entry unavailable or ambiguous')

  const url = new URL(matches[0].url)
  const base = new URL(baseUrl)
  if (url.origin !== base.origin || url.username || url.password || url.hash) {
    throw new Error('DSH web authentication entry authority mismatch')
  }
  return url.href
}
