import { ParsableWhirlpool, WhirlpoolData } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import fetch from 'node-fetch'

import { WHIRLPOOL_ADDRESS } from '../config.js'
import { connection } from '../global.js'
import { retryOnThrow } from '../utils/retryOnThrow.js'

const WHIRLPOOLS_API = 'https://api.mainnet.orca.so/v1/whirlpool/list'

interface WhirlpoolApiResponse {
	whirlpools: Whirlpool[]
}

interface Whirlpool {
	address: string
	tokenA: TokenData
	tokenB: TokenData
}

interface TokenData {
	mint: string
	symbol: string
	name: string
	decimals: number
	coingeckoId: null | string
}

type PoolInfo = {
	tokenAMint: PublicKey
	tokenBMint: PublicKey
	tokenADecimals: number
	tokenBDecimals: number
	tokenACoingeckoId: string
}

export const getPoolInfo = async (): Promise<PoolInfo> => {
	try {
		const res = (await (await fetch(WHIRLPOOLS_API)).json()) as WhirlpoolApiResponse
		const whirlpool = res.whirlpools.find(({ address }) => address === WHIRLPOOL_ADDRESS.toString())

		if (!whirlpool) {
			throw Error('Invalid whirlpool address')
		}
		if (!whirlpool.tokenA.coingeckoId) {
			throw Error('Whirlpool token A does not have corresponding coingecko id')
		}

		return {
			tokenAMint: new PublicKey(whirlpool.tokenA.mint),
			tokenBMint: new PublicKey(whirlpool.tokenB.mint),
			tokenADecimals: whirlpool.tokenA.decimals,
			tokenBDecimals: whirlpool.tokenB.decimals,
			tokenACoingeckoId: whirlpool.tokenA.coingeckoId,
		}
	} catch (error) {
		return getPoolInfo()
	}
}

export const getWhirlpoolData = async (): Promise<WhirlpoolData> => {
	const whirlpoolAccount = await retryOnThrow(() => connection.getAccountInfo(WHIRLPOOL_ADDRESS))
	const whirlpoolAccountData = ParsableWhirlpool.parse(whirlpoolAccount?.data)
	if (!whirlpoolAccountData) {
		throw Error(`Whirlpool account does not exist: ${WHIRLPOOL_ADDRESS.toString()}`)
	}
	return whirlpoolAccountData
}
