import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAccount, useWalletClient, usePublicClient, useConnect } from 'wagmi'
import { Encryptable } from '@cofhe/sdk'
import { arbitrumSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/web'
import { arbSepolia } from '@cofhe/sdk/chains'
import { FORMS_CONTRACT, FORMS_ABI } from '../lib/contract'

const cofheConfig = createCofheConfig({ supportedChains: [arbSepolia] })
const cofheClient = createCofheClient(cofheConfig)

const QTYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'SCALE', 'YES_NO', 'RATING']

export default function FormRespond() {
  const { formId } = useParams<{ formId: string }>()
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  const [questions, setQuestions] = useState<{ qType: number; slotCount: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState<Record<number, number | number[]>>({})
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'submitting' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [alreadyResponded, setAlreadyResponded] = useState(false)
  const [formClosed, setFormClosed] = useState(false)
  const [responseCount, setResponseCount] = useState(0)

  useEffect(() => {
    if (!formId || !publicClient) return
    ;(async () => {
      try {
        const form = await publicClient.readContract({ address: FORMS_CONTRACT, abi: FORMS_ABI, functionName: 'getForm', args: [formId as `0x${string}`] }) as any
        if (!form.exists) { setLoading(false); return }
        setResponseCount(Number(form.responseCount))
        const block = await publicClient.getBlock({ blockTag: 'latest' }) as any
        const l1Block = Number(block.l1BlockNumber ?? block.number)
        console.log('[FormRespond] l1Block:', l1Block, 'endBlock:', Number(form.endBlock))
        setFormClosed(l1Block > Number(form.endBlock))
        if (address) {
          const r = await publicClient.readContract({ address: FORMS_CONTRACT, abi: FORMS_ABI, functionName: 'hasResponded', args: [formId as `0x${string}`, address] }) as boolean
          setAlreadyResponded(r)
        }
        const qs: typeof questions = []
        for (let i = 1; i <= form.questionCount; i++) {
          const q = await publicClient.readContract({ address: FORMS_CONTRACT, abi: FORMS_ABI, functionName: 'getQuestion', args: [formId as `0x${string}`, i] }) as any
          qs.push({ qType: q.qType, slotCount: q.slotCount })
        }
        setQuestions(qs)
      } catch (e) { console.error(e) }
      finally { setLoading(false) }
    })()
  }, [formId, publicClient, address])

  const totalQ = questions.length
  const current = questions[currentQ]
  const progress = totalQ > 0 ? ((currentQ + 1) / totalQ) * 100 : 0

  function isAnswered(qi: number) { const a = answers[qi]; return a !== undefined && (Array.isArray(a) ? a.length > 0 : true) }

  async function handleSubmit() {
    if (!formId || !walletClient || !address || !publicClient) return
    setStatus('encrypting'); setError('')
    try {
      await cofheClient.connect(publicClient as any, walletClient as any)
      const flat: number[] = []
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi]; const ans = answers[qi]
        if (QTYPES[q.qType] === 'MULTI_CHOICE') {
          const sel = (ans as number[]) ?? []
          for (let s = 0; s < q.slotCount; s++) flat.push(sel.includes(s) ? 1 : 0)
        } else {
          for (let s = 0; s < q.slotCount; s++) flat.push(s === (ans as number) ? 1 : 0)
        }
      }
      const encrypted = await cofheClient.encryptInputs(flat.map(v => Encryptable.uint32(BigInt(v)))).execute()
      const encoded = encrypted.map(e => ({ ctHash: e.ctHash, securityZone: e.securityZone, utype: e.utype, signature: e.signature as `0x${string}` }))
      setStatus('submitting')
      const fees = await publicClient.estimateFeesPerGas()
      const hash = await walletClient.writeContract({
        chain: arbitrumSepolia, account: address, address: FORMS_CONTRACT, abi: FORMS_ABI,
        functionName: 'submitResponse', args: [formId as `0x${string}`, encoded],
        maxFeePerGas: fees.maxFeePerGas! * 2n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas! * 2n,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      setStatus('done')
    } catch (e: any) { setError(e.shortMessage ?? e.message ?? String(e)); setStatus('error') }
  }

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#64e3e5] border-t-transparent rounded-full animate-spin" /></div>
  if (questions.length === 0) return <div className="text-center py-20 text-sm text-[#a7aeb1]">Form not found.</div>

  if (status === 'done' || alreadyResponded) return (
    <div className="max-w-md mx-auto text-center py-12">
      <div className="bg-white rounded-2xl border border-[#e0e8e9]  p-8">
        <div className="w-14 h-14 bg-[#64e3e5]/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-[#64e3e5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2 className="text-lg font-semibold text-[#011823] mb-2">Response Submitted!</h2>
        <p className="text-sm text-[#a7aeb1]">Your answers are FHE-encrypted. Only aggregates will be revealed.</p>
        <Link to={`/f/${formId}/results`} className="text-sm text-[#64e3e5] hover:underline mt-4 inline-block font-medium">View Results →</Link>
      </div>
    </div>
  )

  if (formClosed) return (
    <div className="max-w-md mx-auto text-center py-12">
      <p className="text-sm text-[#a7aeb1] mb-3">This form has closed.</p>
      <Link to={`/f/${formId}/results`} className="text-sm text-[#64e3e5] hover:underline font-medium">View Results →</Link>
    </div>
  )

  return (
    <div className="max-w-md mx-auto py-6">
      {/* Progress */}
      <div className="h-1.5 bg-[#e0e8e9] rounded-full mb-8 overflow-hidden">
        <div className="h-full bg-[#64e3e5] rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      {/* Question */}
      {current && (
        <div className="bg-white rounded-2xl border border-[#e0e8e9]  p-6 min-h-[300px] flex flex-col">
          <p className="text-xs text-[#a7aeb1] mb-1">{currentQ + 1} of {totalQ}</p>
          <h2 className="text-xl font-semibold text-[#011823] mb-8">Question {currentQ + 1}</h2>

          <div className="flex-1 flex flex-col gap-2.5">
            {(QTYPES[current.qType] === 'SINGLE_CHOICE' || QTYPES[current.qType] === 'YES_NO') &&
              (QTYPES[current.qType] === 'YES_NO' ? ['Yes', 'No'] : Array.from({ length: current.slotCount }, (_, i) => `Option ${i + 1}`)).map((label, idx) => (
                <button key={idx} onClick={() => setAnswers(p => ({ ...p, [currentQ]: idx }))}
                  className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 text-left transition-all ${answers[currentQ] === idx ? 'border-[#64e3e5] bg-[#64e3e5]/5' : 'border-[#e0e8e9] hover:border-[#a7aeb1]'}`}>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${answers[currentQ] === idx ? 'border-[#64e3e5]' : 'border-[#a7aeb1]'}`}>
                    {answers[currentQ] === idx && <div className="w-2.5 h-2.5 rounded-full bg-[#64e3e5]" />}
                  </div>
                  <span className="text-sm text-[#011823] font-medium">{label}</span>
                </button>
              ))
            }
            {QTYPES[current.qType] === 'MULTI_CHOICE' &&
              Array.from({ length: current.slotCount }, (_, idx) => {
                const sel = (answers[currentQ] as number[] | undefined) ?? []
                const isOn = sel.includes(idx)
                return (
                  <button key={idx} onClick={() => setAnswers(p => ({ ...p, [currentQ]: isOn ? sel.filter(i => i !== idx) : [...sel, idx] }))}
                    className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 text-left transition-all ${isOn ? 'border-[#64e3e5] bg-[#64e3e5]/5' : 'border-[#e0e8e9] hover:border-[#a7aeb1]'}`}>
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${isOn ? 'border-[#64e3e5] bg-[#64e3e5]' : 'border-[#a7aeb1]'}`}>
                      {isOn && <svg className="w-3 h-3 text-[#011823]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                    <span className="text-sm text-[#011823] font-medium">Option {idx + 1}</span>
                  </button>
                )
              })
            }
            {(QTYPES[current.qType] === 'SCALE' || QTYPES[current.qType] === 'RATING') && (
              <div className="flex flex-wrap gap-2 justify-center mt-4">
                {Array.from({ length: current.slotCount }, (_, i) => (
                  <button key={i} onClick={() => setAnswers(p => ({ ...p, [currentQ]: i }))}
                    className={`w-11 h-11 rounded-xl border-2 text-sm font-semibold transition-all ${answers[currentQ] === i ? 'border-[#64e3e5] bg-[#64e3e5] text-[#011823]' : 'border-[#e0e8e9] text-[#a7aeb1] hover:border-[#a7aeb1]'}`}>
                    {i + 1}
                  </button>
                ))}
                <p className="w-full text-center text-xs text-[#a7aeb1] mt-2">
                  {QTYPES[current.qType] === 'SCALE' ? '1 = lowest, 10 = highest' : '1 = poor, 5 = excellent'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Nav */}
      <div className="flex items-center gap-3 mt-5">
        {currentQ > 0 && <button onClick={() => setCurrentQ(q => q - 1)} className="px-5 py-3 bg-[#e0e8e9] text-[#a7aeb1] font-medium rounded-xl text-sm hover:bg-[#a7aeb1]/30">Back</button>}
        <div className="flex-1" />
        {currentQ < totalQ - 1 ? (
          <button onClick={() => setCurrentQ(q => q + 1)} disabled={!isAnswered(currentQ)}
            className="px-6 py-3 bg-[#64e3e5] text-[#011823] font-semibold rounded-xl text-sm disabled:opacity-40 hover:bg-[#a6eeef] transition-colors">Next</button>
        ) : !isConnected ? (
          <button onClick={() => connect({ connector: injected() })}
            className="px-6 py-3 bg-[#64e3e5] text-[#011823] font-semibold rounded-xl text-sm hover:bg-[#a6eeef] transition-colors">
            Connect Wallet to Submit
          </button>
        ) : (
          <button onClick={() => void handleSubmit()} disabled={!isAnswered(currentQ) || status !== 'idle'}
            className="px-6 py-3 bg-[#64e3e5] text-[#011823] font-semibold rounded-xl text-sm disabled:opacity-40 hover:bg-[#a6eeef] transition-colors flex items-center gap-2">
            {status !== 'idle' && <div className="w-4 h-4 border-2 border-[#011823]/30 border-t-[#011823] rounded-full animate-spin" />}
            {status === 'encrypting' ? 'Encrypting…' : status === 'submitting' ? 'Submitting…' : 'Submit'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-500 mt-3 text-center">{error}</p>}
      <p className="text-xs text-[#a7aeb1] text-center mt-6">{responseCount} responses · Encrypted with FHE</p>
    </div>
  )
}
