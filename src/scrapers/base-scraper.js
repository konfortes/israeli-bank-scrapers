import { EventEmitter } from 'events';

import { SCRAPE_PROGRESS_TYPES, LOGIN_RESULT, ERRORS } from '../constants';

const SCRAPE_PROGRESS = 'SCRAPE_PROGRESS';

function createErrorResult(errorType, errorMessage) {
  return {
    success: false,
    errorType,
    errorMessage,
  };
}

function createTimeoutError(errorMessage) {
  return createErrorResult(ERRORS.TIMEOUT, errorMessage);
}

function createGenericError(errorMessage) {
  return createErrorResult(ERRORS.GENERIC, errorMessage);
}

function createEmptyAccount(accountNumber) {
  return {
    accountNumber,
    txns: [],
    summary: {},
    payments: [],
  };
}

function mergeAccounts(accounts, newAccounts, newAccountPropertyName) {
  newAccounts.forEach((newAccount) => {
    let account = accounts.find(
      account => account.accountNumber === newAccount.accountNumber,
    );
    if (!account) {
      account = createEmptyAccount(newAccount.accountNumber);
      accounts.push(account);
    }

    account[newAccountPropertyName] = newAccount[newAccountPropertyName];
  });
}

class BaseScraper {
  constructor(options) {
    this.options = options;
    this.eventEmitter = new EventEmitter();
  }

  async initialize() {
    this.emitProgress(SCRAPE_PROGRESS_TYPES.INITIALIZING);
  }


  async createResult() {
    this.emitProgress(SCRAPE_PROGRESS_TYPES.SCRAPE_DATA);
    const transactionsResult = await this.fetchData();
    if (!transactionsResult.success) {
      return transactionsResult;
    }

    this.emitProgress(SCRAPE_PROGRESS_TYPES.SCRAPE_SUMMARY);
    const summaryResult = await this.fetchSummary();
    if (!summaryResult.success) {
      return summaryResult;
    }

    this.emitProgress(SCRAPE_PROGRESS_TYPES.SCRAPE_PAYMENTS);
    const paymentsResult = await this.fetchPayments();
    if (!paymentsResult.success) {
      return paymentsResult;
    }

    const accounts = [];
    mergeAccounts(accounts, transactionsResult.accounts, 'txns');
    mergeAccounts(accounts, summaryResult.accounts, 'summary');
    mergeAccounts(accounts, paymentsResult.accounts, 'payments');

    return { success: true, accounts };
  }

  async scrape(credentials) {
    this.emitProgress(SCRAPE_PROGRESS_TYPES.START_SCRAPING);
    await this.initialize();

    let loginResult;
    try {
      loginResult = await this.login(credentials);
    } catch (e) {
      loginResult = e.timeout ?
        createTimeoutError(e.message) :
        createGenericError(e.message);
    }

    let scrapeResult;
    if (loginResult.success) {
      try {
        scrapeResult = await this.createResult();
      } catch (e) {
        scrapeResult =
          e.timeout ?
            createTimeoutError(e.message) :
            createGenericError(e.message);
      }
    } else {
      scrapeResult = loginResult;
    }

    try {
      await this.terminate();
    } catch (e) {
      scrapeResult = createGenericError(e.message);
    }
    this.emitProgress(SCRAPE_PROGRESS_TYPES.END_SCRAPING);

    return scrapeResult;
  }

  async login() {
    throw new Error(`login() is not created in ${this.options.companyId}`);
  }

  async fetchData() {
    throw new Error(`fetchData() is not created in ${this.options.companyId}`);
  }

  // eslint-disable-next-line class-methods-use-this
  async fetchPayments() {
    return {
      success: true,
      accounts: [],
    };
  }

  // eslint-disable-next-line class-methods-use-this
  async fetchSummary() {
    return {
      success: true,
      accounts: [],
    };
  }

  async terminate() {
    this.emitProgress(SCRAPE_PROGRESS_TYPES.TERMINATING);
  }

  emitProgress(type) {
    this.emit(SCRAPE_PROGRESS, { type });
  }

  emit(eventName, payload) {
    this.eventEmitter.emit(eventName, this.options.companyId, payload);
  }

  onProgress(func) {
    this.eventEmitter.on(SCRAPE_PROGRESS, func);
  }
}

export { BaseScraper, LOGIN_RESULT };
