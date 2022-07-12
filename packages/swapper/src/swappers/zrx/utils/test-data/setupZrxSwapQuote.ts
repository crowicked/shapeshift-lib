import { HDWallet } from '@shapeshiftoss/hdwallet-core'
import { Asset, KnownChainIds } from '@shapeshiftoss/types'

import { BuildTradeInput } from '../../../../api'
import { FOX, WETH } from '../../../utils/test-data/assets'
import { ZrxQuoteResponse } from '../../types'

export const setupZrxTradeQuoteResponse = () => {
  const sellAsset: Asset = { ...FOX }
  const buyAsset: Asset = { ...WETH }
  const quoteResponse: ZrxQuoteResponse = {
    sellAmount: '1000000000000000000',
    allowanceTarget: 'allowanceTargetAddress',
    price: '1',
    to: '0x123',
    data: '0x1234',
    gas: '1235',
    gasPrice: '1236',
    sources: [],
    buyAmount: ''
  }
  return { quoteResponse, buyAsset, sellAsset }
}

export const setupBuildTrade = () => {
  const sellAsset: Asset = { ...FOX }
  const buyAsset: Asset = { ...WETH }
  const buildTradeInput: BuildTradeInput = {
    chainId: KnownChainIds.EthereumMainnet,
    sellAmount: '1000000000000000000',
    buyAsset,
    sendMax: false,
    sellAssetAccountNumber: 0,
    buyAssetAccountNumber: 0,
    sellAsset,
    wallet: <HDWallet>{},
    receiveAddress: '0xc770eefad204b5180df6a14ee197d99d808ee52d'
  }
  return { buildTradeInput, buyAsset, sellAsset }
}

export const setupExecuteTrade = () => {
  const sellAsset: Asset = { ...FOX }
  const buyAsset: Asset = { ...WETH }
  const executeTradeInput = {
    sellAmount: '1000000000000000000',
    allowanceTarget: 'allowanceTargetAddress',
    price: '1',
    to: '0x123',
    gas: '1235',
    gasPrice: '1236',
    buyAmount: '',
    buyAsset,
    sellAsset,
    sendMax: false,
    sellAssetAccountNumber: 0,
    txData: '0x0',
    depositAddress: '0x0',
    receiveAddress: '0x0',
    feeData: { fee: '0', chainSpecific: {}, tradeFee: '0' },
    rate: '0',
    sources: []
  }
  return { executeTradeInput, buyAsset, sellAsset }
}
