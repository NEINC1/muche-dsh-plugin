import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAuthenticatedEntryUrl } from '../lib/desktop/auth-url.js'

const ORIGIN = 'http://127.0.0.1:3080'

test('桌宠登录 URL 从当前 WebServer 的官方签名入口事件取得', () => {
  const server = { getOrigin: () => ORIGIN }
  let call
  const ctx = {
    webServer: server,
    emit(subject, event, baseUrl, entries) {
      call = { subject, event, baseUrl }
      entries.push({ label: 'dsh web', url: `${baseUrl}/?token=host-signed`, open: true })
    },
  }

  assert.equal(getAuthenticatedEntryUrl(ctx), `${ORIGIN}/?token=host-signed`)
  assert.deepEqual(call, { subject: server, event: 'webserver/entry-url', baseUrl: ORIGIN })
})

test('没有唯一宿主签名入口或入口 authority 不同就失败关闭', () => {
  const server = { getOrigin: () => ORIGIN }
  const empty = { webServer: server, emit() {} }
  assert.throws(() => getAuthenticatedEntryUrl(empty), /authentication entry unavailable/)

  const ambiguous = {
    webServer: server,
    emit(_subject, _event, baseUrl, entries) {
      entries.push({ label: 'dsh web', url: `${baseUrl}/?token=first`, open: true })
      entries.push({ label: 'dsh web', url: `${baseUrl}/?token=second`, open: true })
    },
  }
  assert.throws(() => getAuthenticatedEntryUrl(ambiguous), /authentication entry unavailable or ambiguous/)

  const foreign = {
    webServer: server,
    emit(_subject, _event, _baseUrl, entries) {
      entries.push({ label: 'dsh web', url: 'https://attacker.example/?token=unexpected', open: true })
    },
  }
  assert.throws(() => getAuthenticatedEntryUrl(foreign), /authority mismatch/)

  const credentialed = {
    webServer: server,
    emit(_subject, _event, _baseUrl, entries) {
      entries.push({ label: 'dsh web', url: 'http://user:secret@127.0.0.1:3080/?token=unexpected', open: true })
    },
  }
  assert.throws(() => getAuthenticatedEntryUrl(credentialed), /authority mismatch/)
})
