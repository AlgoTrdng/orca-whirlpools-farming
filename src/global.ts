import {
	AccountFetcher,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	WhirlpoolContext,
} from '@orca-so/whirlpools-sdk'
import { AnchorProvider } from '@project-serum/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair } from '@solana/web3.js'

import { LOWER_BOUNDARY_PCT, RPC_URL, UPPER_BOUNDARY_PCT, WALLET_PRIVATE_KEY } from './config.js'
import { getPoolInfo } from './orca/pool.js'

export const connection = new Connection(RPC_URL, 'confirmed')

export const fetcher = new AccountFetcher(connection)

export const wallet = Keypair.fromSecretKey(WALLET_PRIVATE_KEY)
export const provider = AnchorProvider.env()
export const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)

const whirlpoolInfo = await getPoolInfo()
export const { tokenACoingeckoId } = whirlpoolInfo
export const tokenA = {
	mint: whirlpoolInfo.tokenAMint,
	ATAddress: getAssociatedTokenAddressSync(whirlpoolInfo.tokenAMint, wallet.publicKey),
	decimals: whirlpoolInfo.tokenADecimals,
}
export const tokenB = {
	mint: whirlpoolInfo.tokenBMint,
	ATAddress: getAssociatedTokenAddressSync(whirlpoolInfo.tokenBMint, wallet.publicKey),
	decimals: whirlpoolInfo.tokenBDecimals,
}

export const upperBoundaryBps = UPPER_BOUNDARY_PCT / 100
export const lowerBoundaryBps = LOWER_BOUNDARY_PCT / 100
