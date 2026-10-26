// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react'

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
}

let nextMessageId = 1

/** Bubble chat window: streaming assistant replies, Enter to send. */
export function ChatApp() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const streamingRef = useRef(false)

  useEffect(() => {
    window.baize
      .chatHistory()
      .then((history: { role: 'user' | 'assistant'; content: string }[]) =>
        setMessages(
          history.map((turn: { role: 'user' | 'assistant'; content: string }) => ({
            id: nextMessageId++,
            role: turn.role,
            content: turn.content,
          })),
        ),
      )
      .catch(() => setMessages([]))
    const offDelta = window.baize.onChatDelta((text: string) => {
      setMessages((previous) => {
        const last = previous.at(-1)
        if (last && last.role === 'assistant') {
          return [...previous.slice(0, -1), { ...last, content: last.content + text }]
        }
        return [...previous, { id: nextMessageId++, role: 'assistant', content: text }]
      })
    })
    const offDone = window.baize.onChatDone(() => {
      streamingRef.current = false
      setSending(false)
    })
    const offError = window.baize.onChatError((message: string) => {
      streamingRef.current = false
      setSending(false)
      setError(message)
    })
    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streamingRef.current) return
    setError(null)
    setMessages((previous) => [...previous, { id: nextMessageId++, role: 'user', content: text }])
    setInput('')
    streamingRef.current = true
    setSending(true)
    const result = await window.baize.chatSend(text)
    if (!result.ok) {
      streamingRef.current = false
      setSending(false)
      setError(result.error ?? '发送失败')
    }
  }, [input])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void send()
      }
    },
    [send],
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontFamily: 'sans-serif',
      }}
    >
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {messages.length === 0 && (
          <p style={{ color: '#999', fontSize: 13 }}>
            和白泽说点什么吧…（第一次见面它会问你的名字）
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              display: 'flex',
              justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                maxWidth: '78%',
                padding: '7px 11px',
                borderRadius: 12,
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                background: message.role === 'user' ? '#dcecfa' : '#f5f1e8',
                border: '1px solid rgba(0,0,0,0.08)',
              }}
            >
              {message.content}
            </div>
          </div>
        ))}
        {error && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: '#fdecec',
              border: '1px solid #e8b4b4',
              color: '#8a3a3a',
              fontSize: 12,
              margin: '8px 0',
            }}
          >
            {error}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 10, borderTop: '1px solid #eee' }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={sending ? '白泽正在输入…' : '输入消息，Enter 发送'}
          disabled={sending}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #ddd',
            fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: 'none',
            background: '#4a90d9',
            color: 'white',
            fontSize: 13,
          }}
        >
          发送
        </button>
      </div>
    </div>
  )
}
