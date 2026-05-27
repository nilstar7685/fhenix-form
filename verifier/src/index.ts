// @ts-nocheck
import "dotenv/config"
import express from "express"
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { arbitrumSepolia } from "viem/chains"
import { createCofheConfig, createCofheClient } from "@cofhe/sdk/node"
import { arbSepolia } from "@cofhe/sdk/chains"

// ─── Config ───
const FORMS_ADDRESS = (process.env.FHENIX_FORMS_ADDRESS ?? "") as `0x${string}`
const RPC_URL = process.env.FHENIX_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc"
const PRIVATE_KEY = process.env.VERIFIER_PRIVATE_KEY ?? ""
const DEPLOYMENT_BLOCK = BigInt(process.env.DEPLOYMENT_L2_BLOCK ?? "268000000")
const PORT = Number(process.env.PORT ?? 3002)
const INTERVAL_MS = 60_000

// ─── ABI ───
const FORMS_ABI = [
  {
    type: "function", name: "getForm",
    inputs: [{ name: "formId", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "id", type: "bytes32" }, { name: "creator", type: "address" },
      { name: "metadataHash", type: "bytes32" }, { name: "questionCount", type: "uint8" },
      { name: "startBlock", type: "uint32" }, { name: "endBlock", type: "uint32" },
      { name: "responseCount", type: "uint32" }, { name: "revealed", type: "bool" },
      { name: "exists", type: "bool" },
    ]}],
    stateMutability: "view",
  },
  {
    type: "function", name: "getQuestion",
    inputs: [{ name: "formId", type: "bytes32" }, { name: "questionId", type: "uint8" }],
    outputs: [{ type: "tuple", components: [
      { name: "questionId", type: "uint8" }, { name: "qType", type: "uint8" },
      { name: "slotCount", type: "uint8" }, { name: "labelHash", type: "bytes32" },
      { name: "exists", type: "bool" },
    ]}],
    stateMutability: "view",
  },
  {
    type: "function", name: "requestFormReveal",
    inputs: [{ name: "formId", type: "bytes32" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "ctHashes",
    inputs: [{ name: "formId", type: "bytes32" }, { name: "questionId", type: "uint8" }, { name: "slotId", type: "uint8" }],
    outputs: [{ type: "bytes32" }], stateMutability: "view",
  },
  {
    type: "function", name: "publishFormResult",
    inputs: [
      { name: "formId", type: "bytes32" }, { name: "questionId", type: "uint8" },
      { name: "slotId", type: "uint8" }, { name: "plaintext", type: "uint32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "event", name: "FormCreated",
    inputs: [
      { name: "formId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "endBlock", type: "uint32", indexed: false },
    ],
  },
] as const

// ─── Clients ───
let pub: PublicClient
let wallet: WalletClient
let cofhe: any
const revealed = new Set<string>()

async function init() {
  const key = (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`
  const account = privateKeyToAccount(key)

  pub = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC_URL) })
  wallet = createWalletClient({ chain: arbitrumSepolia, transport: http(RPC_URL), account })

  const cofheConfig = createCofheConfig({ supportedChains: [arbSepolia] })
  cofhe = createCofheClient(cofheConfig)
  await cofhe.connect(pub, wallet)
  console.log(`[forms-verifier] Connected as ${account.address}`)
}

async function getL1Block(): Promise<number> {
  const block = await pub.getBlock({ blockTag: "latest" }) as any
  return Number(block.l1BlockNumber ?? block.number)
}

async function getGasFees() {
  const fee = await pub.estimateFeesPerGas()
  return { maxFeePerGas: fee.maxFeePerGas! * 2n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas! * 2n }
}

async function discoverForms(): Promise<`0x${string}`[]> {
  const logs = await pub.getLogs({
    address: FORMS_ADDRESS,
    event: FORMS_ABI.find((e: any) => e.name === "FormCreated")! as any,
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: "latest",
  }).catch(() => [] as any[])
  return logs.map((l: any) => l.args.formId as `0x${string}`)
}

async function revealForm(formId: `0x${string}`) {
  const form = await pub.readContract({
    address: FORMS_ADDRESS, abi: FORMS_ABI, functionName: "getForm", args: [formId],
  }) as any

  if (!form.exists || form.revealed || form.responseCount === 0) {
    console.log(`[forms-verifier] Skipping ${formId.slice(0, 12)}… exists=${form.exists} revealed=${form.revealed} responses=${form.responseCount}`)
    return
  }

  const l1 = await getL1Block()
  console.log(`[forms-verifier] Form ${formId.slice(0, 12)}… endBlock=${form.endBlock} currentBlock=${l1} responses=${form.responseCount} revealed=${form.revealed}`)
  if (l1 <= form.endBlock + 2) {
    console.log(`[forms-verifier] Form ${formId.slice(0, 12)}… still open (${form.endBlock + 2 - l1} blocks remaining)`)
    return
  }

  console.log(`[forms-verifier] Revealing form ${formId.slice(0, 12)}…`)

  // Request reveal
  await new Promise(r => setTimeout(r, 15_000))
  const fees = await getGasFees()
  const revealHash = await (wallet as any).writeContract({
    address: FORMS_ADDRESS, abi: FORMS_ABI,
    functionName: "requestFormReveal", args: [formId], ...fees,
  })
  await pub.waitForTransactionReceipt({ hash: revealHash })
  console.log(`[forms-verifier] requestFormReveal confirmed`)

  // Publish per question×slot
  for (let q = 1; q <= form.questionCount; q++) {
    const qData = await pub.readContract({
      address: FORMS_ADDRESS, abi: FORMS_ABI, functionName: "getQuestion", args: [formId, q],
    }) as any

    for (let s = 0; s < qData.slotCount; s++) {
      const ctHashHex = await pub.readContract({
        address: FORMS_ADDRESS, abi: FORMS_ABI, functionName: "ctHashes", args: [formId, q, s],
      }) as `0x${string}`

      if (BigInt(ctHashHex) === 0n) continue

      const { decryptedValue, signature } = await cofhe.decryptForTx(BigInt(ctHashHex)).withoutPermit().execute()
      const f = await getGasFees()
      const hash = await (wallet as any).writeContract({
        address: FORMS_ADDRESS, abi: FORMS_ABI,
        functionName: "publishFormResult",
        args: [formId, q, s, Number(decryptedValue), signature], ...f,
      })
      await pub.waitForTransactionReceipt({ hash })
      console.log(`[forms-verifier]   Q${q} S${s} = ${decryptedValue}`)
    }
  }

  revealed.add(formId)
  console.log(`[forms-verifier] Form ${formId.slice(0, 12)}… done.`)
}

async function runLoop() {
  try {
    const formIds = await discoverForms()
    for (const fid of formIds) {
      if (revealed.has(fid)) continue
      await revealForm(fid).catch((e: any) => {
        if (!/still open/i.test(e.message ?? "")) console.error(`[forms-verifier] Error:`, e.message)
      })
    }
  } catch (e: any) {
    console.error("[forms-verifier] Loop error:", e.message)
  }
}

// ─── Express ───
const app = express()
app.get("/health", (_req, res) => res.json({ status: "ok", service: "fhenix-forms-verifier", contract: FORMS_ADDRESS }))

app.post("/admin/reveal/:formId", async (req, res) => {
  try {
    await revealForm(req.params.formId as `0x${string}`)
    res.json({ ok: true, formId: req.params.formId })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Start ───
async function main() {
  if (!FORMS_ADDRESS || !PRIVATE_KEY) {
    console.error("[forms-verifier] Missing FHENIX_FORMS_ADDRESS or VERIFIER_PRIVATE_KEY")
    process.exit(1)
  }

  await init()

  app.listen(PORT, () => console.log(`[forms-verifier] Listening on :${PORT}`))

  console.log("[forms-verifier] Runner started — checking every 60s")
  void runLoop()
  setInterval(() => void runLoop(), INTERVAL_MS)
}

main()
