import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMock = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}

vi.mock('../../composables/useApi', () => ({
  useApi: () => apiMock,
}))

import { useKeysStore, type KeyRecord } from '../keys'

describe('keys store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.get.mockReset()
    apiMock.post.mockReset()
    apiMock.put.mockReset()
    apiMock.delete.mockReset()
  })

  it('fetches keys list', async () => {
    const store = useKeysStore()
    const keys: KeyRecord[] = [
      {
        id: 1,
        key_preview: 'sk-****',
        display_name: 'Primary',
        status: 'active',
        weight: 1,
        error_count: 0,
        max_errors: 3,
        total_requests: 10,
        successful_requests: 9,
        failed_requests: 1,
        last_used_at: null,
        last_error_at: null,
        last_error_message: null,
        created_at: '2025-01-01',
        updated_at: '2025-01-01',
        quota: null,
      },
    ]
    apiMock.get.mockResolvedValue({ keys })

    const result = await store.fetchKeys()

    expect(apiMock.get).toHaveBeenCalledWith('/api/keys')
    expect(result).toEqual(keys)
    expect(store.keys).toEqual(keys)
  })

  it('adds a key to state', async () => {
    const store = useKeysStore()
    const key: KeyRecord = {
      id: 2,
      key_preview: 'sk-****',
      display_name: 'Secondary',
      status: 'disabled',
      weight: 1,
      error_count: 0,
      max_errors: 3,
      total_requests: 0,
      successful_requests: 0,
      failed_requests: 0,
      last_used_at: null,
      last_error_at: null,
      last_error_message: null,
      created_at: '2025-01-02',
      updated_at: '2025-01-02',
      quota: null,
    }
    apiMock.post.mockResolvedValue(key)

    const result = await store.addKey({ key_value: 'sk-test' })

    expect(apiMock.post).toHaveBeenCalledWith('/api/keys', { key_value: 'sk-test' })
    expect(result).toEqual(key)
    expect(store.keys).toEqual([key])
  })

  it('updates key status and errors', async () => {
    const store = useKeysStore()
    store.keys = [
      {
        id: 3,
        key_preview: 'sk-****',
        display_name: 'Tertiary',
        status: 'disabled',
        weight: 1,
        error_count: 5,
        max_errors: 3,
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        last_used_at: null,
        last_error_at: null,
        last_error_message: null,
        created_at: '2025-01-03',
        updated_at: '2025-01-03',
        quota: null,
      },
    ]

    apiMock.post.mockResolvedValue({ status: 'ok' })

    await store.enableKey(3)
    expect(store.keys[0].status).toBe('active')

    await store.disableKey(3)
    expect(store.keys[0].status).toBe('disabled')

    await store.resetErrors(3)
    expect(store.keys[0].error_count).toBe(0)
  })

  it('deletes a key from state', async () => {
    const store = useKeysStore()
    store.keys = [
      {
        id: 4,
        key_preview: 'sk-****',
        display_name: 'Delete Me',
        status: 'active',
        weight: 1,
        error_count: 0,
        max_errors: 3,
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        last_used_at: null,
        last_error_at: null,
        last_error_message: null,
        created_at: '2025-01-04',
        updated_at: '2025-01-04',
        quota: null,
      },
    ]

    apiMock.delete.mockResolvedValue({ status: 'ok' })

    await store.deleteKey(4)

    expect(apiMock.delete).toHaveBeenCalledWith('/api/keys/4')
    expect(store.keys).toEqual([])
  })

  it('gracefully ignores missing keys for status updates', async () => {
    const store = useKeysStore()
    apiMock.post.mockResolvedValue({ status: 'ok' })

    await store.enableKey(999)
    await store.disableKey(999)
    await store.resetErrors(999)

    expect(store.keys).toEqual([])
  })

  it('imports, edits and queues batch operations', async () => {
    const store = useKeysStore()
    store.keys = [
      {
        id: 7,
        key_preview: 'tvly-****',
        display_name: 'Before',
        status: 'disabled',
        weight: 1,
        error_count: 0,
        max_errors: 5,
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        last_used_at: null,
        last_error_at: null,
        last_error_message: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        quota: null,
      },
    ]
    const queue = {
      status: 'queued' as const,
      requested: 1,
      enqueued: 1,
      deduplicated: 0,
      promoted: 0,
      missing: 0,
      queue: {
        pending: 1,
        running: 0,
        runningKeyId: null,
        blockedUntil: null,
        nextRequestAt: null,
        lastRequestAt: null,
      },
    }
    apiMock.post
      .mockResolvedValueOnce({ inserted: 2 })
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce(queue)
    apiMock.put.mockResolvedValue({ status: 'ok' })
    apiMock.get.mockResolvedValue(queue.queue)

    expect(await store.importKeys(['one', 'two'])).toBe(2)
    await store.updateKey(7, { display_name: 'After' })
    expect(store.keys[0].display_name).toBe('After')
    await store.batchEnable([7])
    expect(store.keys[0].status).toBe('active')
    await store.batchDisable([7])
    expect(store.keys[0].status).toBe('disabled')
    expect(await store.batchTest([7])).toEqual(queue)
    expect(await store.fetchUsageSyncStatus()).toEqual(queue.queue)

    expect(apiMock.post).toHaveBeenNthCalledWith(1, '/api/keys/import', { keys: ['one', 'two'] })
    expect(apiMock.put).toHaveBeenCalledWith('/api/keys/7', { display_name: 'After' })
    expect(apiMock.get).toHaveBeenCalledWith('/api/settings/sync/status')
  })
})
