import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount, useWalletClient, usePublicClient, useSwitchChain } from 'wagmi'
import { keccak256, stringToHex, encodePacked } from 'viem'
import { arbitrumSepolia } from 'wagmi/chains'
import { FORMS_CONTRACT, FORMS_ABI } from '../lib/contract'

type QType = 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'SCALE' | 'YES_NO' | 'RATING'
interface QuestionDraft { id: number; type: QType; text: string; options: string[] }

const QTYPE_NUM: Record<QType, number> = { SINGLE_CHOICE: 0, MULTI_CHOICE: 1, SCALE: 2, YES_NO: 3, RATING: 4 }
const SLOT_COUNT: Record<QType, number | null> = { SINGLE_CHOICE: null, MULTI_CHOICE: null, SCALE: 10, YES_NO: 2, RATING: 5 }
const TYPE_LABELS: Record<QType, string> = { SINGLE_CHOICE: 'Single Choice', MULTI_CHOICE: 'Multi Choice', SCALE: 'Scale 1–10', YES_NO: 'Yes / No', RATING: 'Rating 1–5' }

export default function FormBuilder() {
  const navigate = useNavigate()
  const { address, isConnected, chainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { switchChain } = useSwitchChain()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [durationDays, setDurationDays] = useState(7)
  const [durationUnit, setDurationUnit] = useState<'days' | 'blocks'>('days')
  const [questions, setQuestions] = useState<QuestionDraft[]>([
    { id: 1, type: 'SINGLE_CHOICE', text: '', options: ['', ''] }
  ])
  const [nextId, setNextId] = useState(2)
  const [status, setStatus] = useState<'idle' | 'deploying' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [createdFormId, setCreatedFormId] = useState('')

  const dragItem = useRef<number | null>(null)
  const dragOver = useRef<number | null>(null)

  function handleDragStart(idx: number) { dragItem.current = idx }
  function handleDragEnter(idx: number) { dragOver.current = idx }
  function handleDragEnd() {
    if (dragItem.current === null || dragOver.current === null) return
    const copy = [...questions]
    const [dragged] = copy.splice(dragItem.current, 1)
    copy.splice(dragOver.current, 0, dragged)
    setQuestions(copy)
    dragItem.current = null; dragOver.current = null
  }

  function addQuestion() {
    if (questions.length >= 20) return
    setQuestions([...questions, { id: nextId, type: 'SINGLE_CHOICE', text: '', options: ['', ''] }])
    setNextId(n => n + 1)
  }
  function updateQ(idx: number, patch: Partial<QuestionDraft>) {
    const copy = [...questions]; copy[idx] = { ...copy[idx], ...patch }; setQuestions(copy)
  }
  function removeQ(idx: number) {
    if (questions.length <= 1) return
    setQuestions(questions.filter((_, i) => i !== idx))
  }

  const isValid = title.trim() !== '' && questions.every(q =>
    q.text.trim() !== '' && ((q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE')
      ? q.options.length >= 2 && q.options.every(o => o.trim() !== '') : true)
  )

  async function handleDeploy() {
    if (!isValid) { setError('Please fill all required fields'); return }
    if (!address) { setError('Please connect your wallet'); return }
    if (chainId !== arbitrumSepolia.id) {
      try { switchChain({ chainId: arbitrumSepolia.id }); setError('Switching to Arbitrum Sepolia — try again after switching') } catch { setError('Please switch to Arbitrum Sepolia') }
      return
    }
    if (!walletClient) { setError('Wallet not ready — please switch to Arbitrum Sepolia and retry'); return }
    if (!publicClient) { setError('Network not ready — try refreshing'); return }
    setStatus('deploying'); setError('')
    try {
      const formId = keccak256(encodePacked(['address', 'string', 'uint256'], [address, title, BigInt(Date.now())]))
      const metadataHash = keccak256(stringToHex(title))
      const durationBlocks = durationUnit === 'blocks' ? durationDays : durationDays * 345600
      const qTypes = questions.map(q => QTYPE_NUM[q.type])
      const slotCounts = questions.map(q => SLOT_COUNT[q.type] ?? q.options.length)
      const labelHashes = questions.map(q => keccak256(stringToHex(q.text)))

      const fees = await publicClient.estimateFeesPerGas()
      const hash = await walletClient.writeContract({
        chain: arbitrumSepolia, account: address,
        address: FORMS_CONTRACT, abi: FORMS_ABI,
        functionName: 'createForm',
        args: [formId, metadataHash, durationBlocks, questions.length, qTypes, slotCounts, labelHashes],
        maxFeePerGas: fees.maxFeePerGas! * 2n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas! * 2n,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      setCreatedFormId(formId)
      setStatus('done')
    } catch (e: any) {
      setError(e.shortMessage ?? e.message ?? String(e)); setStatus('error')
    }
  }

  if (status === 'done') return (
    <div className="max-w-md mx-auto text-center py-12">
      <div className="bg-white rounded-2xl border border-[#e0e8e9]  p-8">
        <div className="w-14 h-14 bg-[#64e3e5]/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-[#64e3e5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2 className="text-lg font-semibold text-[#011823] mb-2">Form Created!</h2>
        <p className="text-sm text-[#a7aeb1] mb-4">{title}</p>
        <div className="bg-[#e0e8e9]/50 border border-[#e0e8e9] rounded-xl p-3 mb-4">
          <p className="text-xs text-[#a7aeb1] mb-1">Share this link:</p>
          <p className="text-sm font-mono text-[#011823] break-all">{window.location.origin}/f/{createdFormId}</p>
        </div>
        <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/f/${createdFormId}`)}
          className="text-sm text-[#64e3e5] hover:underline mb-6 block mx-auto font-medium">Copy link ↗</button>
        <div className="flex gap-3 justify-center">
          <button onClick={() => navigate('/dashboard')} className="px-5 py-2.5 bg-[#64e3e5] text-[#011823] text-sm font-medium rounded-full hover:bg-[#64e3e5]/90">Dashboard</button>
          <button onClick={() => navigate(`/f/${createdFormId}`)} className="px-5 py-2.5 border border-[#e0e8e9] text-[#a7aeb1] text-sm font-medium rounded-full hover:border-[#64e3e5]">Preview</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[#011823]">Create Form</h1>
        <p className="text-sm text-[#a7aeb1] mt-0.5">Drag ⠿ to reorder questions. All responses are FHE-encrypted.</p>
      </div>

      <div className="bg-white rounded-2xl border border-[#e0e8e9]  p-5 space-y-4 mb-4">
        <div>
          <label className="block text-xs font-semibold text-[#a7aeb1] mb-1.5 uppercase tracking-wide">Title *</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Team Feedback Q2"
            className="w-full px-4 py-2.5 bg-[#f8fafa] border border-[#e0e8e9] rounded-xl text-sm text-[#011823] placeholder-[#a7aeb1] focus:outline-none focus:ring-2 focus:ring-[#64e3e5]/30 focus:border-[#64e3e5]" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-[#a7aeb1] mb-1.5 uppercase tracking-wide">Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this form about?" rows={2}
            className="w-full px-4 py-2.5 bg-[#f8fafa] border border-[#e0e8e9] rounded-xl text-sm text-[#011823] placeholder-[#a7aeb1] resize-none focus:outline-none focus:ring-2 focus:ring-[#64e3e5]/30 focus:border-[#64e3e5]" />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs font-semibold text-[#a7aeb1] uppercase tracking-wide">Duration</label>
          <input type="number" min={1} max={durationUnit === 'blocks' ? 100000 : 90} value={durationDays} onChange={e => setDurationDays(Number(e.target.value))}
            className="w-24 px-3 py-2 border border-[#e0e8e9] rounded-lg text-sm text-[#011823] focus:outline-none focus:ring-2 focus:ring-[#64e3e5]/30" />
          <select value={durationUnit} onChange={e => setDurationUnit(e.target.value as 'days' | 'blocks')}
            className="px-2 py-2 border border-[#e0e8e9] rounded-lg text-sm text-[#011823] focus:outline-none">
            <option value="days">Days</option>
            <option value="blocks">Blocks (testing)</option>
          </select>
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-3">
        {questions.map((q, idx) => (
          <div key={q.id}
            draggable onDragStart={() => handleDragStart(idx)} onDragEnter={() => handleDragEnter(idx)}
            onDragEnd={handleDragEnd} onDragOver={e => e.preventDefault()}
            className="bg-white border border-[#e0e8e9] rounded-xl p-4 space-y-3 cursor-move hover:border-[#64e3e5]/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-[#a7aeb1] cursor-grab select-none text-lg">⠿</span>
              <span className="text-xs font-bold text-[#a7aeb1] bg-[#e0e8e9] px-2 py-0.5 rounded">Q{idx + 1}</span>
              <select value={q.type} onChange={e => {
                const type = e.target.value as QType
                updateQ(idx, { type, options: (type === 'SINGLE_CHOICE' || type === 'MULTI_CHOICE') ? ['', ''] : [] })
              }} className="text-xs border border-[#e0e8e9] rounded-lg px-2 py-1 bg-white text-[#a7aeb1] focus:outline-none">
                {(Object.keys(TYPE_LABELS) as QType[]).map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
              {questions.length > 1 && (
                <button onClick={() => removeQ(idx)} className="ml-auto text-[#a7aeb1] hover:text-red-500 text-sm transition-colors">✕</button>
              )}
            </div>
            <input value={q.text} onChange={e => updateQ(idx, { text: e.target.value })}
              placeholder="Question text *"
              className="w-full px-3 py-2 text-sm border border-[#e0e8e9] rounded-lg text-[#011823] placeholder-[#a7aeb1] focus:outline-none focus:ring-1 focus:ring-[#64e3e5]/30" />

            {(q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') && (
              <div className="space-y-2 ml-6">
                {q.options.map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2">
                    <div className={`w-4 h-4 border-2 border-[#a7aeb1] shrink-0 ${q.type === 'SINGLE_CHOICE' ? 'rounded-full' : 'rounded'}`} />
                    <input value={opt} onChange={e => {
                      const opts = [...q.options]; opts[oi] = e.target.value; updateQ(idx, { options: opts })
                    }} placeholder={`Option ${oi + 1}`}
                      className="flex-1 px-2.5 py-1.5 text-sm border border-[#e0e8e9] rounded-lg text-[#011823] placeholder-[#a7aeb1] focus:outline-none" />
                    {q.options.length > 2 && (
                      <button onClick={() => updateQ(idx, { options: q.options.filter((_, i) => i !== oi) })} className="text-[#a7aeb1] hover:text-red-500 text-xs">✕</button>
                    )}
                  </div>
                ))}
                {q.options.length < 10 && (
                  <button onClick={() => updateQ(idx, { options: [...q.options, ''] })} className="text-xs text-[#64e3e5] hover:underline ml-6 font-medium">+ Add Option</button>
                )}
              </div>
            )}
            {q.type === 'SCALE' && <p className="text-xs text-[#a7aeb1] ml-6">Respondents pick a value from 1 to 10</p>}
            {q.type === 'YES_NO' && <p className="text-xs text-[#a7aeb1] ml-6">Respondents answer Yes or No</p>}
            {q.type === 'RATING' && <p className="text-xs text-[#a7aeb1] ml-6">Respondents rate 1 to 5 stars</p>}
          </div>
        ))}

        {questions.length < 20 && (
          <button onClick={addQuestion}
            className="w-full py-3 border-2 border-dashed border-[#e0e8e9] rounded-xl text-sm font-medium text-[#a7aeb1] hover:border-[#64e3e5] hover:text-[#64e3e5] transition-colors">
            + Add Question
          </button>
        )}
      </div>

      {/* Deploy */}
      <div className="mt-6 bg-white rounded-2xl border border-[#e0e8e9]  p-5">
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
        <button onClick={() => void handleDeploy()}
          disabled={!isValid || !isConnected || status === 'deploying'}
          className="w-full py-3.5 bg-[#64e3e5] hover:bg-[#a6eeef] text-[#011823] font-semibold rounded-xl text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
          {status === 'deploying' && <div className="w-4 h-4 border-2 border-[#011823]/30 border-t-[#011823] rounded-full animate-spin" />}
          {status === 'deploying' ? 'Creating…' : !isConnected ? 'Connect Wallet' : 'Create & Share Form'}
        </button>
        <p className="text-xs text-[#a7aeb1] text-center mt-2">You'll get a shareable link after creation</p>
      </div>
    </div>
  )
}
