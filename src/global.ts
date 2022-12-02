import {
	AccountFetcher,
	buildWhirlpoolClient,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	WhirlpoolContext,
} from '@orca-so/whirlpools-sdk'
import { AnchorProvider } from '@project-serum/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection } from '@solana/web3.js'

import { RPC_URL } from './config.js'
import { SOL_MINT, USDC_MINT } from './constants.js'

export const connection = new Connection(RPC_URL, 'confirmed')

export const fetcher = new AccountFetcher(connection)

export const provider = AnchorProvider.env()
export const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)
export const whirlpoolClient = buildWhirlpoolClient(ctx)

export const solATAddress = getAssociatedTokenAddressSync(SOL_MINT, ctx.wallet.publicKey)
export const usdcATAddress = getAssociatedTokenAddressSync(USDC_MINT, ctx.wallet.publicKey)
