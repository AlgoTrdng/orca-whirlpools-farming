import { Connection } from '@solana/web3.js'
import { AccountFetcher, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, WhirlpoolContext } from '@orca-so/whirlpools-sdk'
import { AnchorProvider } from '@project-serum/anchor'

import { RPC_URL } from './config.js'
import { getQuote } from './utils/quote.js'
import { USDC_MINT, SOL_USDC_WHIRLPOOL_ADDRESS } from './constants.js'

const init = async () => {
  const provider = AnchorProvider.env()
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)
  const whirlpoolClient = buildWhirlpoolClient(ctx)
  
  const connection = new Connection(RPC_URL, 'confirmed')
  const fetcher = new AccountFetcher(connection)

  return { whirlpoolClient, fetcher }
}

const { fetcher, whirlpoolClient } = await init()

const solWhirlpool = await whirlpoolClient.getPool(SOL_USDC_WHIRLPOOL_ADDRESS, true)

const res = await getQuote({
  whirlpool: solWhirlpool,
  inputMint: USDC_MINT,
  inputAmountUi: 1,
  fetcher,
})

console.log(res)
