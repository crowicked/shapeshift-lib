import {
  AssetId,
  ChainId,
  cosmosChainId,
  osmosisAssetId,
  osmosisChainId
} from '@shapeshiftoss/caip'
import { cosmos, osmosis, toPath } from '@shapeshiftoss/chain-adapters'
import { bip32ToAddressNList } from '@shapeshiftoss/hdwallet-core'
import { Asset } from '@shapeshiftoss/types'

import {
  ApprovalNeededOutput,
  BuildTradeInput,
  BuyAssetBySellIdInput,
  ExecuteTradeInput,
  GetTradeQuoteInput,
  MinMaxOutput,
  SwapError,
  SwapErrorTypes,
  Swapper,
  SwapperType,
  Trade,
  TradeQuote,
  TradeResult,
  TradeTxs
} from '../../api'
import { bn, bnOrZero } from '../utils/bignumber'
import {
  COSMO_OSMO_CHANNEL,
  DEFAULT_SOURCE,
  MAX_SWAPPER_SELL,
  OSMO_COSMO_CHANNEL
} from './utils/constants'
import {
  getRateInfo,
  performIbcTransfer,
  pollForAtomChannelBalance,
  pollForComplete,
  SymbolDenomMapping,
  symbolDenomMapping
} from './utils/helpers'
import { OsmoSwapperDeps } from './utils/types'
export class OsmosisSwapper implements Swapper<ChainId> {
  readonly name = 'Osmosis'
  supportAssets: string[]
  deps: OsmoSwapperDeps

  getType() {
    return SwapperType.Osmosis
  }

  constructor(deps: OsmoSwapperDeps) {
    this.deps = deps
    this.supportAssets = ['cosmos:cosmoshub-4/slip44:118', 'cosmos:osmosis-1/slip44:118']
  }

  async getTradeTxs(tradeResult: TradeResult): Promise<TradeTxs> {
    return {
      sellTxid: tradeResult.tradeId,
      buyTxid: tradeResult.tradeId
    }
  }

  async getUsdRate(input: Pick<Asset, 'symbol' | 'assetId'>): Promise<string> {
    const { symbol } = input

    const sellAssetSymbol = symbol
    const buyAssetSymbol = 'USDC'
    const sellAmount = '1'
    const { rate: osmoRate } = await getRateInfo(
      'OSMO',
      buyAssetSymbol,
      sellAmount,
      this.deps.osmoUrl
    )

    if (sellAssetSymbol != 'OSMO') {
      const { rate } = await getRateInfo(sellAssetSymbol, 'OSMO', sellAmount, this.deps.osmoUrl)
      return bnOrZero(rate).times(osmoRate).toString()
    }

    return osmoRate
  }

  async getMinMax(input: { sellAsset: Asset }): Promise<MinMaxOutput> {
    const { sellAsset } = input
    const usdRate = await this.getUsdRate({ ...sellAsset })
    const minimum = bn(1).dividedBy(bnOrZero(usdRate)).toString()
    const maximum = MAX_SWAPPER_SELL

    return {
      minimum,
      maximum
    }
  }

  async approvalNeeded(): Promise<ApprovalNeededOutput> {
    return { approvalNeeded: false }
  }

  async approveInfinite(): Promise<string> {
    throw new Error('OsmosisSwapper: approveInfinite unimplemented')
  }

  filterBuyAssetsBySellAssetId(args: BuyAssetBySellIdInput): string[] {
    const { sellAssetId } = args
    if (!this.supportAssets.includes(sellAssetId)) return []
    return this.supportAssets
  }

  filterAssetIdsBySellable(): AssetId[] {
    return this.supportAssets
  }

  async buildTrade(args: BuildTradeInput): Promise<Trade<ChainId>> {
    const { sellAsset, buyAsset, sellAmount } = args

    if (!sellAmount) {
      throw new Error('sellAmount is required')
    }

    const { tradeFee, rate, buyAmount } = await getRateInfo(
      sellAsset.symbol,
      buyAsset.symbol,
      sellAmount !== '0' ? sellAmount : '1',
      this.deps.osmoUrl
    )

    //convert amount to base
    const amountBaseSell = String(bnOrZero(sellAmount).dp(0))

    const osmosisAdapter = this.deps.adapterManager.get(osmosisChainId) as
      | osmosis.ChainAdapter
      | undefined

    if (!osmosisAdapter) throw new Error('Failed to get Osmosis adapter')

    const feeData = await osmosisAdapter.getFeeData({})
    const fee = feeData.average.txFee

    return {
      buyAmount,
      buyAsset,
      feeData: { fee, tradeFee },
      rate,
      receiveAddress: '',
      sellAmount: amountBaseSell,
      sellAsset,
      sellAssetAccountNumber: 0,
      sources: [{ name: 'Osmosis', proportion: '100' }]
    }
  }

  async getTradeQuote(input: GetTradeQuoteInput): Promise<TradeQuote<ChainId>> {
    const { sellAsset, buyAsset, sellAmount } = input
    if (!sellAmount) {
      throw new Error('sellAmount is required')
    }
    const { tradeFee, rate, buyAmount } = await getRateInfo(
      sellAsset.symbol,
      buyAsset.symbol,
      sellAmount !== '0' ? sellAmount : '1',
      this.deps.osmoUrl
    )

    const { minimum, maximum } = await this.getMinMax(input)

    const osmosisAdapter = this.deps.adapterManager.get(osmosisChainId) as
      | osmosis.ChainAdapter
      | undefined

    if (!osmosisAdapter) throw new Error('Failed to get Osmosis adapter')

    const feeData = await osmosisAdapter.getFeeData({})
    const fee = feeData.average.txFee

    return {
      buyAsset,
      feeData: { fee, tradeFee },
      maximum,
      minimum,
      sellAssetAccountNumber: 0,
      rate,
      sellAsset,
      sellAmount,
      buyAmount,
      sources: DEFAULT_SOURCE,
      allowanceContract: ''
    }
  }

  async executeTrade({ trade, wallet }: ExecuteTradeInput<ChainId>): Promise<TradeResult> {
    const { sellAsset, buyAsset, sellAmount, sellAssetAccountNumber, receiveAddress } = trade

    const isFromOsmo = sellAsset.assetId === osmosisAssetId
    const sellAssetDenom = symbolDenomMapping[sellAsset.symbol as keyof SymbolDenomMapping]
    const buyAssetDenom = symbolDenomMapping[buyAsset.symbol as keyof SymbolDenomMapping]
    let ibcSellAmount

    const osmosisAdapter = this.deps.adapterManager.get(osmosisChainId) as
      | osmosis.ChainAdapter
      | undefined
    const cosmosAdapter = this.deps.adapterManager.get(cosmosChainId) as
      | cosmos.ChainAdapter
      | undefined

    if (cosmosAdapter && osmosisAdapter) {
      let sellAddress
      const feeData = await osmosisAdapter.getFeeData({})
      const gas = feeData.average.chainSpecific.gasLimit

      if (!isFromOsmo) {
        const sellBip44Params = cosmosAdapter.buildBIP44Params({
          accountNumber: Number(sellAssetAccountNumber)
        })

        sellAddress = await cosmosAdapter.getAddress({ wallet, bip44Params: sellBip44Params })

        if (!sellAddress) throw Error('Failed to get atomAddress!')

        const transfer = {
          sender: sellAddress,
          receiver: receiveAddress,
          amount: String(sellAmount)
        }

        const responseAccount = await cosmosAdapter.getAccount(sellAddress)
        const accountNumber = responseAccount.chainSpecific.accountNumber || '0'
        const sequence = responseAccount.chainSpecific.sequence || '0'

        const { tradeId } = await performIbcTransfer(
          transfer,
          cosmosAdapter,
          wallet,
          this.deps.osmoUrl,
          'uatom',
          COSMO_OSMO_CHANNEL,
          '0',
          accountNumber,
          sequence,
          gas
        )

        // wait till confirmed
        const pollResult = await pollForComplete(tradeId, this.deps.cosmosUrl)
        if (pollResult !== 'success') throw new Error('ibc transfer failed')

        ibcSellAmount = await pollForAtomChannelBalance(receiveAddress, this.deps.osmoUrl)
      } else if (isFromOsmo) {
        const sellBip44Params = osmosisAdapter.buildBIP44Params({
          accountNumber: Number(sellAssetAccountNumber)
        })
        sellAddress = await osmosisAdapter.getAddress({ wallet, bip44Params: sellBip44Params })

        if (!sellAddress) throw Error('Failed to get osmoAddress!')
      } else {
        throw Error('Pair not supported! ' + sellAsset.symbol + '_' + buyAsset.symbol)
      }

      const osmoAddress = isFromOsmo ? sellAddress : receiveAddress
      const responseAccount = await osmosisAdapter.getAccount(osmoAddress)

      const accountNumber = responseAccount.chainSpecific.accountNumber || '0'
      const sequence = responseAccount.chainSpecific.sequence || '0'

      const bip44Params = osmosisAdapter.buildBIP44Params({
        accountNumber: Number(accountNumber)
      })
      const path = toPath(bip44Params)
      const osmoAddressNList = bip32ToAddressNList(path)

      const tx = {
        memo: '',
        fee: {
          amount: [
            {
              amount: trade.feeData.fee.toString(),
              denom: 'uosmo'
            }
          ],
          gas
        },
        signatures: null,
        msg: [
          {
            type: 'osmosis/gamm/swap-exact-amount-in',
            value: {
              sender: osmoAddress,
              routes: [
                {
                  poolId: '1', // TODO: should probably get this from the util pool call
                  tokenOutDenom: buyAssetDenom
                }
              ],
              tokenIn: {
                denom: sellAssetDenom,
                amount: ibcSellAmount ?? sellAmount
              },
              tokenOutMinAmount: '1' // slippage tolerance
            }
          }
        ]
      }

      const signTxInput = {
        txToSign: {
          tx,
          addressNList: osmoAddressNList,
          chain_id: 'osmosis-1',
          account_number: accountNumber,
          sequence
        },
        wallet
      }

      const signed = await osmosisAdapter.signTransaction(signTxInput)
      const tradeId = await osmosisAdapter.broadcastTransaction(signed)

      if (isFromOsmo) {
        const pollResult = await pollForComplete(tradeId, this.deps.osmoUrl)
        if (pollResult !== 'success') throw new Error('osmo swap failed')

        const amount = await pollForAtomChannelBalance(sellAddress, this.deps.osmoUrl)
        const transfer = {
          sender: sellAddress,
          receiver: receiveAddress,
          amount: String(amount)
        }

        const ibcResponseAccount = await osmosisAdapter.getAccount(sellAddress)
        const ibcAccountNumber = ibcResponseAccount.chainSpecific.accountNumber || '0'
        const ibcSequence = ibcResponseAccount.chainSpecific.sequence || '0'

        await performIbcTransfer(
          transfer,
          osmosisAdapter,
          wallet,
          this.deps.cosmosUrl,
          buyAssetDenom,
          OSMO_COSMO_CHANNEL,
          trade.feeData.fee,
          ibcAccountNumber,
          ibcSequence,
          gas
        )
      }

      return { tradeId: tradeId || 'error' }
    } else {
      throw new SwapError('[executeTrade]: unsupported trade', {
        code: SwapErrorTypes.SIGN_AND_BROADCAST_FAILED,
        fn: 'executeTrade'
      })
    }
  }
}
