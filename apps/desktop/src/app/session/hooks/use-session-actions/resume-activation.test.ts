import { useStore } from '@nanostores/react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionRoute } from '@/app/routes'
import { getLatestSessionMessages } from '@/hermes'
import { requestGatewayForAgent } from '@/store/gateway'
import { $notifications, clearNotifications } from '@/store/notifications'
import { ensureGatewayAgent, ensureGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $messages,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $resumeReattachSessionId,
  $selectedStoredSessionId,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setMessages,
  setResumeExhaustedSessionId,
  setSelectedStoredSessionId
} from '@/store/session'
import { tombstoneSessions, untombstoneSessions } from '@/store/session-removal'

import { deferred } from '../../../../test/deferred'
import { useSessionStateCache } from '../use-session-state-cache'

import { resumeFailedToastId, resumeRetryDelayMs } from './resume-latches'
import { resolveStoredSession } from './utils'

import { useSessionActions } from './index'

vi.mock('./utils', async original => ({
  ...(await original<Record<string, unknown>>()),
  resolveStoredSession: vi.fn()
}))
vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/gateway', async original => ({
  ...(await original<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayAgent: vi.fn(),
  ensureGatewayProfile: vi.fn()
}))

const owner = { connectionId: 'fixture-source', profile: 'work' }
const storedId = 'stored-a'
const outage = new Error('Gateway unavailable')
const waitForRetry = () => vi.advanceTimersByTimeAsync(resumeRetryDelayMs(0))

function mountChat() {
  let route = storedId

  const ambient = vi.fn(async () => {
    throw new Error('Unexpected ambient RPC')
  })

  const { result } = renderHook(() => {
    const activeSessionId = useStore($activeSessionId)
    const selectedStoredSessionId = useStore($selectedStoredSessionId)
    const busyRef = useRef(false)

    const cache = useSessionStateCache({
      activeSessionId,
      busyRef,
      selectedStoredSessionId,
      setAwaitingResponse,
      setBusy,
      setMessages
    })

    return useSessionActions({
      ...cache,
      activeSessionId,
      busyRef,
      creatingSessionRef: useRef(false),
      getRouteToken: () => sessionRoute(route),
      getRoutedStoredSessionId: () => route,
      navigate: vi.fn(),
      requestGateway: ambient,
      routedSessionId: route,
      selectedStoredSessionId
    }).resumeSession
  })

  return {
    ambient,
    resume(id: string, captured?: typeof owner) {
      route = id

      return result.current(id, true, captured)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  setSelectedStoredSessionId(storedId)
  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: [] } as never)
  vi.mocked(requestGatewayForAgent).mockResolvedValue({
    session_id: 'runtime-a',
    resumed: storedId,
    info: {},
    messages: []
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  untombstoneSessions([storedId])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setResumeExhaustedSessionId(null)
  setMessages([])
  setConnection(null)
  clearNotifications()
})

it('recovers the same selected chat on its captured socket before issuing session.resume', async () => {
  const chat = mountChat()
  const captured = { ...owner }
  vi.mocked(ensureGatewayAgent).mockRejectedValueOnce(outage)

  await act(async () => {
    const pending = chat.resume(storedId, captured)
    await vi.advanceTimersByTimeAsync(0)
    captured.profile = 'changed-after-open'
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
    await waitForRetry()
    await pending
  })

  expect(vi.mocked(ensureGatewayAgent).mock.calls).toEqual(Array(2).fill([owner.connectionId, owner.profile]))
  expect(vi.mocked(requestGatewayForAgent).mock.calls).toEqual([
    [owner.connectionId, owner.profile, 'session.resume', expect.objectContaining({ session_id: storedId })]
  ])
  expect(chat.ambient).not.toHaveBeenCalled()
  expect($activeSessionId.get()).toBe('runtime-a')
  expect($notifications.get().some(n => n.id === resumeFailedToastId(storedId))).toBe(false)
})

it('stops at the first failure when only the ambient connection is known', async () => {
  setConnection({ connectionId: owner.connectionId, mode: 'remote' } as never)
  const chat = mountChat()
  vi.mocked(ensureGatewayAgent).mockRejectedValue(outage)
  await act(async () => {
    await chat.resume(storedId)
    await waitForRetry()
  })

  expect(ensureGatewayAgent).toHaveBeenCalledTimes(1)
  expect(ensureGatewayProfile).not.toHaveBeenCalled()
  expect($resumeExhaustedSessionId.get()).toBe(storedId)
  expect(requestGatewayForAgent).not.toHaveBeenCalled()
  expect(chat.ambient).not.toHaveBeenCalled()
})

it('requires a profile on a connection-tagged row before retrying activation', async () => {
  const chat = mountChat()
  const row = { id: storedId, connection_id: owner.connectionId }
  vi.mocked(resolveStoredSession, { partial: true }).mockResolvedValueOnce(row)
  vi.mocked(ensureGatewayAgent).mockRejectedValueOnce(outage)

  await act(async () => {
    const pending = chat.resume(storedId)
    await waitForRetry()
    await pending
  })

  expect(resolveStoredSession).toHaveBeenCalledWith(storedId, undefined)
  expect(vi.mocked(ensureGatewayAgent).mock.calls).toEqual([[owner.connectionId, 'default']])
  expect(ensureGatewayProfile).not.toHaveBeenCalled()
  expect(requestGatewayForAgent).not.toHaveBeenCalled()
  expect(getLatestSessionMessages).not.toHaveBeenCalled()
  expect(chat.ambient).not.toHaveBeenCalled()
  expect($messages.get()).toHaveLength(0)
  expect($resumeExhaustedSessionId.get()).toBe(storedId)
})

it.each([false, true])('preserves history and offers Retry for an empty pane (history=%s)', async history => {
  const chat = mountChat()

  if (history) {
    setMessages([{ id: 'saved', role: 'assistant', parts: [{ type: 'text', text: 'Saved history' }] }])
  }

  const visible = $messages.get()
  vi.mocked(ensureGatewayAgent).mockRejectedValue(outage)

  await act(async () => {
    const pending = chat.resume(storedId, owner)
    await waitForRetry()
    await pending
  })

  expect(ensureGatewayAgent).toHaveBeenCalledTimes(2)
  expect($messages.get()).toBe(visible)
  expect($resumeExhaustedSessionId.get()).toBe(history ? null : storedId)
  expect($resumeFailedSessionId.get()).toBeNull()
  expect($resumeReattachSessionId.get()).toBeNull()
  expect(requestGatewayForAgent).not.toHaveBeenCalled()
})

it.each(['navigation', 'runtime', 'removal'])('ignores a late activation after %s', async change => {
  const chat = mountChat()
  const late = deferred<void>()
  vi.mocked(ensureGatewayAgent).mockRejectedValueOnce(outage).mockReturnValueOnce(late.promise)

  await act(async () => {
    const pending = chat.resume(storedId, owner)
    await waitForRetry()
    expect(ensureGatewayAgent).toHaveBeenCalledTimes(2)

    const replacement = deferred<void>()
    let newest: Promise<unknown> | undefined

    if (change === 'navigation') {
      vi.mocked(ensureGatewayAgent).mockReturnValueOnce(replacement.promise)
      const leaving = chat.resume('stored-b', owner)
      newest = chat.resume(storedId, owner)
      await leaving
    } else if (change === 'runtime') {
      setActiveSessionId('new-runtime')
    } else {
      tombstoneSessions([storedId])
    }

    if (change === 'removal') {
      late.resolve()
    } else {
      late.reject(outage)
    }

    await pending
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
    expect($resumeExhaustedSessionId.get()).toBeNull()
    expect($notifications.get().some(n => n.id === resumeFailedToastId(storedId))).toBe(false)
    replacement.resolve()
    await newest
  })
})
