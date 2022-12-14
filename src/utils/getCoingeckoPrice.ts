import fetch from 'node-fetch'
import { setTimeout } from 'node:timers/promises'

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/simple/price'

export const getCoingeckoPriceInUsd = async (tokenId: string): Promise<number> => {
	try {
		const res = (await (
			await fetch(`${COINGECKO_API_URL}?ids=${tokenId}&vs_currencies=usd`)
		).json()) as Record<string, { usd: number }>
		return res[tokenId].usd
	} catch (error) {
		await setTimeout(500)
		return getCoingeckoPriceInUsd(tokenId)
	}
}
