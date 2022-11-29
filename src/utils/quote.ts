import { Percentage } from '@orca-so/common-sdk'
import { AccountFetcher, ORCA_WHIRLPOOL_PROGRAM_ID, swapQuoteByInputToken, Whirlpool } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import { BN } from 'bn.js'

const getDecimals = (inputMint: PublicKey, whirlpool: Whirlpool) => {
  const tokenA = whirlpool.getTokenAInfo()
  const tokenB = whirlpool.getTokenBInfo()
  if (tokenA.mint.toString() === inputMint.toString()) {
    return [tokenA.decimals, tokenB.decimals]
  }
  return [tokenB.decimals, tokenA.decimals]
}

type GetQuoteParams = {
  whirlpool: Whirlpool,
  inputMint: PublicKey,
  inputAmountUi: number,
  fetcher: AccountFetcher,
}

export const getQuote = async ({
  whirlpool,
  inputMint,
  inputAmountUi,
  fetcher,
}: GetQuoteParams) => {
  const [inputDecimals, outputDecimals] = getDecimals(inputMint, whirlpool)

  const inputAmount = new BN(inputAmountUi * 10 ** inputDecimals)
  const res = await swapQuoteByInputToken(
    whirlpool,
    inputMint,
    inputAmount,
    new Percentage(new BN(25), new BN(10000)),
    ORCA_WHIRLPOOL_PROGRAM_ID,
    fetcher,
    true,
  )

  const outAmountUi = res.estimatedAmountOut.toNumber() / 10 ** outputDecimals
  const price = inputAmountUi / outAmountUi
  return {
    inputAmountUi,
    outAmountUi,
    price,
  }
}
