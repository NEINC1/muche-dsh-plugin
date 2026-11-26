export interface MessageReceiptResponse {
  receipt_owner: string
  accepted_message_ids: string[]
  unavailable_message_ids: string[]
}

export function createMessageReceiptQueue(options: {
  scope: string
  owner: string
  storage: () => Storage | null
  isCurrent: () => boolean
  send: (ids: string[], owner: string) => Promise<MessageReceiptResponse>
  onError?: (...args: unknown[]) => void
}): {
  enqueue: (ids: string[]) => void
  retryNow: () => void
  flush: () => Promise<void>
  dispose: () => void
}
