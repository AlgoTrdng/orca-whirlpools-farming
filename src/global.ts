import {
	AccountFetcher,
	buildWhirlpoolClient,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	WhirlpoolContext,
} from '@orca-so/whirlpools-sdk'
import { AnchorProvider } from '@project-serum/anchor'
import { Connection } from '@solana/web3.js'

import { RPC_URL } from './config.js'

export const connection = new Connection(RPC_URL, 'confirmed')

export const fetcher = new AccountFetcher(connection)

export const provider = AnchorProvider.env()
export const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)
export const whirlpoolClient = buildWhirlpoolClient(ctx)
