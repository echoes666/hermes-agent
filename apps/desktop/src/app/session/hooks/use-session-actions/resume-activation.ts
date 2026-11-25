import {
  $activeSessionId,
  $messages,
  $selectedStoredSessionId,
  sessionOwnerRouteFromRow,
  setResumeExhaustedSessionId
} from '@/store/session'
import {
  captureSessionTombstoneGenerations,
  isSessionRemovalPending,
  tombstoneLifecycleChanged
} from '@/store/session-removal'
import type { SessionProfileRoute } from '@/store/session-request-router'

import { transcriptRestScope } from './provisional-transcript'
import { notifyResumeFailed, type ResumeAttemptOptions, resumeRetryDelayMs } from './resume-latches'
import { openResumeGateway, rememberResolvedResumeOwner, resolveResumeOwner } from './resume-owner'
import { resolveStoredSession } from './utils'

interface ResumeActivation {
  activeSessionIdRef: { readonly current: null | string }
  ambientConnectionId: string
  isCurrentResume: () => boolean
  options: ResumeAttemptOptions | undefined
  ownerRoute: SessionProfileRoute | undefined
  paint: (scope: ReturnType<typeof transcriptRestScope>) => void
  resumeFailed: string
  storedSessionId: string
}

export async function activateResumeGateway({
  activeSessionIdRef,
  ambientConnectionId,
  isCurrentResume,
  options,
  ownerRoute,
  paint,
  resumeFailed,
  storedSessionId
}: ResumeActivation) {
  const runtime = activeSessionIdRef.current
  const publishedRuntime = $activeSessionId.get()
  const tombstones = captureSessionTombstoneGenerations()

  const isCurrent = () =>
    isCurrentResume() &&
    $selectedStoredSessionId.get() === storedSessionId &&
    activeSessionIdRef.current === runtime &&
    $activeSessionId.get() === publishedRuntime &&
    !isSessionRemovalPending(storedSessionId) &&
    !tombstoneLifecycleChanged(tombstones, [storedSessionId])

  const storedForProfile = await resolveStoredSession(storedSessionId, ownerRoute)

  if (!isCurrent()) {
    return null
  }

  const sessionProfile = storedForProfile?.profile
  const { resolvedConnectionId, sessionOwner } = resolveResumeOwner(ownerRoute, storedForProfile, ambientConnectionId)
  const sessionRestScope = transcriptRestScope(ownerRoute, storedForProfile, ambientConnectionId)
  rememberResolvedResumeOwner(storedSessionId, ownerRoute, storedForProfile, sessionOwner)
  paint(sessionRestScope)

  // Only the first open may use a profile-only or ambient route. Capture the
  // retry destination before the first dial can yield to another selection.
  const exactOwner = ownerRoute ?? sessionOwnerRouteFromRow(storedForProfile)
  const opens = [() => openResumeGateway(resolvedConnectionId, ownerRoute, sessionProfile)]

  if (exactOwner?.connectionId.trim() && exactOwner.profile.trim()) {
    opens.push(() => openResumeGateway(exactOwner.connectionId, exactOwner, exactOwner.profile))
  }

  for (const [attempt, open] of opens.entries()) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, resumeRetryDelayMs(0)))
    }

    if (!isCurrent()) {
      break
    }

    try {
      await open()

      return { isCurrent, sessionOwner, sessionProfile, sessionRestScope, storedForProfile }
    } catch (error) {
      if (!isCurrent()) {
        break
      }

      if (attempt + 1 === opens.length) {
        if (!$messages.get().length) {
          setResumeExhaustedSessionId(storedSessionId)
        }

        notifyResumeFailed(error, resumeFailed, storedSessionId, options)
      }
    }
  }

  return null
}
