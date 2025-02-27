import moment, { Moment } from 'moment';
import { Frame, Page } from 'puppeteer';
import { BaseScraperWithBrowser, LoginOptions, LoginResults } from './base-scraper-with-browser';
import {
  clickButton, elementPresentOnPage, pageEval, pageEvalAll, setValue, waitUntilElementFound,
} from '../helpers/elements-interactions';
import {
  Transaction,
  TransactionInstallments,
  TransactionsAccount,
  TransactionStatuses,
  TransactionTypes,
} from '../transactions';
import { ScraperOptions, ScaperScrapingResult, ScraperCredentials } from './base-scraper';
import {
  DOLLAR_CURRENCY, DOLLAR_CURRENCY_SYMBOL, EURO_CURRENCY, EURO_CURRENCY_SYMBOL, SHEKEL_CURRENCY, SHEKEL_CURRENCY_SYMBOL,
} from '../constants';
import { waitUntil } from '../helpers/waiting';
import { filterOldTransactions } from '../helpers/transactions';
import { getDebug } from '../helpers/debug';

const LOGIN_URL = 'https://www.cal-online.co.il/';
const TRANSACTIONS_URL = 'https://services.cal-online.co.il/Card-Holders/Screens/Transactions/Transactions.aspx';
const LONG_DATE_FORMAT = 'DD/MM/YYYY';
const DATE_FORMAT = 'DD/MM/YY';
const InvalidPasswordMessage = 'שם המשתמש או הסיסמה שהוזנו שגויים';

const debug = getDebug('visa-cal');

interface ScrapedTransaction {
  date: string;
  processedDate: string;
  description: string;
  originalAmount: string;
  chargedAmount: string;
  memo: string;
}

async function getLoginFrame(page: Page) {
  let frame: Frame | null = null;
  debug('wait until login frame found');
  await waitUntil(() => {
    frame = page
      .frames()
      .find((f) => f.url().includes('connect.cal-online')) || null;
    return Promise.resolve(!!frame);
  }, 'wait for iframe with login form', 10000, 1000);

  if (!frame) {
    debug('failed to find login frame for 10 seconds');
    throw new Error('failed to extract login iframe');
  }

  return frame;
}

async function hasInvalidPasswordError(page: Page) {
  const frame = await getLoginFrame(page);
  const errorFound = await elementPresentOnPage(frame, 'div.general-error > div');
  const errorMessage = errorFound ? await pageEval(frame, 'div.general-error > div', '', (item) => {
    return (item as HTMLDivElement).innerText;
  }) : '';
  return errorMessage === InvalidPasswordMessage;
}

function getPossibleLoginResults() {
  debug('return possible login results');
  const urls: LoginOptions['possibleResults'] = {
    [LoginResults.Success]: [/AccountManagement/i],
    [LoginResults.InvalidPassword]: [async (options?: { page?: Page}) => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasInvalidPasswordError(page);
    }],
    // [LoginResults.AccountBlocked]: [], // TODO add when reaching this scenario
    // [LoginResults.ChangePassword]: [], // TODO add when reaching this scenario
  };
  return urls;
}

function createLoginFields(credentials: ScraperCredentials) {
  debug('create login fields for username and password');
  return [
    { selector: '[formcontrolname="userName"]', value: credentials.username },
    { selector: '[formcontrolname="password"]', value: credentials.password },
  ];
}


function getAmountData(amountStr: string) {
  const amountStrCln = amountStr.replace(',', '');
  let currency: string | null = null;
  let amount: number | null = null;
  if (amountStrCln.includes(SHEKEL_CURRENCY_SYMBOL)) {
    amount = -parseFloat(amountStrCln.replace(SHEKEL_CURRENCY_SYMBOL, ''));
    currency = SHEKEL_CURRENCY;
  } else if (amountStrCln.includes(DOLLAR_CURRENCY_SYMBOL)) {
    amount = -parseFloat(amountStrCln.replace(DOLLAR_CURRENCY_SYMBOL, ''));
    currency = DOLLAR_CURRENCY;
  } else if (amountStrCln.includes(EURO_CURRENCY_SYMBOL)) {
    amount = -parseFloat(amountStrCln.replace(EURO_CURRENCY_SYMBOL, ''));
    currency = EURO_CURRENCY;
  } else {
    const parts = amountStrCln.split(' ');
    [currency] = parts;
    amount = -parseFloat(parts[1]);
  }

  return {
    amount,
    currency,
  };
}

function getTransactionInstallments(memo: string): TransactionInstallments | null {
  const parsedMemo = (/תשלום (\d+) מתוך (\d+)/).exec(memo || '');

  if (!parsedMemo || parsedMemo.length === 0) {
    return null;
  }

  return {
    number: parseInt(parsedMemo[1], 10),
    total: parseInt(parsedMemo[2], 10),
  };
}
function convertTransactions(txns: ScrapedTransaction[]): Transaction[] {
  debug(`convert ${txns.length} raw transactions to official Transaction structure`);
  return txns.map((txn) => {
    const originalAmountTuple = getAmountData(txn.originalAmount || '');
    const chargedAmountTuple = getAmountData(txn.chargedAmount || '');

    const installments = getTransactionInstallments(txn.memo);
    const txnDate = moment(txn.date, DATE_FORMAT);
    const processedDateFormat =
      txn.processedDate.length === 8 ?
        DATE_FORMAT :
        txn.processedDate.length === 9 || txn.processedDate.length === 10 ?
          LONG_DATE_FORMAT :
          null;
    if (!processedDateFormat) {
      throw new Error('invalid processed date');
    }
    const txnProcessedDate = moment(txn.processedDate, processedDateFormat);

    const result: Transaction = {
      type: installments ? TransactionTypes.Installments : TransactionTypes.Normal,
      status: TransactionStatuses.Completed,
      date: installments ? txnDate.add(installments.number - 1, 'month').toISOString() : txnDate.toISOString(),
      processedDate: txnProcessedDate.toISOString(),
      originalAmount: originalAmountTuple.amount,
      originalCurrency: originalAmountTuple.currency,
      chargedAmount: chargedAmountTuple.amount,
      chargedCurrency: chargedAmountTuple.currency,
      description: txn.description || '',
      memo: txn.memo || '',
    };

    if (installments) {
      result.installments = installments;
    }

    return result;
  });
}

async function fetchTransactionsForAccount(page: Page, startDate: Moment, accountNumber: string, scraperOptions: ScraperOptions): Promise<TransactionsAccount> {
  const startDateValue = startDate.format('MM/YYYY');
  const dateSelector = '[id$="FormAreaNoBorder_FormArea_clndrDebitDateScope_TextBox"]';
  const dateHiddenFieldSelector = '[id$="FormAreaNoBorder_FormArea_clndrDebitDateScope_HiddenField"]';
  const buttonSelector = '[id$="FormAreaNoBorder_FormArea_ctlSubmitRequest"]';
  const nextPageSelector = '[id$="FormAreaNoBorder_FormArea_ctlGridPager_btnNext"]';
  const billingLabelSelector = '[id$=FormAreaNoBorder_FormArea_ctlMainToolBar_lblCaption]';
  const secondaryBillingLabelSelector = '[id$=FormAreaNoBorder_FormArea_ctlSecondaryToolBar_lblCaption]';
  const noDataSelector = '[id$=FormAreaNoBorder_FormArea_msgboxErrorMessages]';

  debug('find the start date index in the dropbox');
  const options = await pageEvalAll(page, '[id$="FormAreaNoBorder_FormArea_clndrDebitDateScope_OptionList"] li', [], (items) => {
    return items.map((el: any) => el.innerText);
  });
  const startDateIndex = options.findIndex((option) => option === startDateValue);

  debug(`scrape ${options.length - startDateIndex} billing cycles`);
  const accountTransactions: Transaction[] = [];
  for (let currentDateIndex = startDateIndex; currentDateIndex < options.length; currentDateIndex += 1) {
    debug('wait for date selector to be found');
    await waitUntilElementFound(page, dateSelector, true);
    debug(`set hidden value of the date selector to be the index ${currentDateIndex}`);
    await setValue(page, dateHiddenFieldSelector, `${currentDateIndex}`);
    debug('wait a second to workaround navigation issue in headless browser mode');
    await page.waitForTimeout(1000);
    debug('click on the filter submit button and wait for navigation');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      clickButton(page, buttonSelector),
    ]);
    debug('check if month has no transactions');
    const pageHasNoTransactions = await pageEval(page, noDataSelector, false, ((element) => {
      const siteValue = ((element as HTMLSpanElement).innerText || '').replace(/[^ א-ת]/g, '');
      return siteValue === 'לא נמצאו נתונים';
    }));

    if (pageHasNoTransactions) {
      debug('page has no transactions');
    } else {
      debug('find the billing date');
      let billingDateLabel = await pageEval(page, billingLabelSelector, '', ((element) => {
        return (element as HTMLSpanElement).innerText;
      }));
      let settlementDateRegex = /\d{1,2}[/]\d{2}[/]\d{2,4}/;

      if (billingDateLabel === '') {
        billingDateLabel = await pageEval(page, secondaryBillingLabelSelector, '', ((element) => {
          return (element as HTMLSpanElement).innerText;
        }));
        settlementDateRegex = /\d{1,2}[/]\d{2,4}/;
      }

      const billingDate = settlementDateRegex.exec(billingDateLabel)?.[0];

      if (!billingDate) {
        throw new Error('failed to fetch process date');
      }

      debug(`found the billing date for that month ${billingDate}`);
      let hasNextPage = false;
      do {
        debug('fetch raw transactions from page');
        const rawTransactions = await pageEvalAll<(ScrapedTransaction | null)[]>(page, '#ctlMainGrid > tbody tr, #ctlSecondaryGrid > tbody tr', [], (items, billingDate) => {
          return (items).map((el) => {
            const columns = el.getElementsByTagName('td');
            if (columns.length === 6) {
              return {
                processedDate: columns[0].innerText,
                date: columns[1].innerText,
                description: columns[2].innerText,
                originalAmount: columns[3].innerText,
                chargedAmount: columns[4].innerText,
                memo: columns[5].innerText,
              };
            }
            if (columns.length === 5) {
              return {
                processedDate: billingDate,
                date: columns[0].innerText,
                description: columns[1].innerText,
                originalAmount: columns[2].innerText,
                chargedAmount: columns[3].innerText,
                memo: columns[4].innerText,
              };
            }
            return null;
          });
        }, billingDate);
        debug(`fetched ${rawTransactions.length} raw transactions from page`);
        accountTransactions.push(...convertTransactions((rawTransactions as ScrapedTransaction[])
          .filter((item) => !!item)));

        debug('check for existance of another page');
        hasNextPage = await elementPresentOnPage(page, nextPageSelector);
        if (hasNextPage) {
          debug('has another page, click on button next and wait for page navigation');
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            await clickButton(page, '[id$=FormAreaNoBorder_FormArea_ctlGridPager_btnNext]'),
          ]);
        }
      } while (hasNextPage);
    }
  }

  debug('filer out old transactions');
  const txns = filterOldTransactions(accountTransactions, startDate, scraperOptions.combineInstallments || false);
  debug(`found ${txns.length} valid transactions out of ${accountTransactions.length} transactions for account ending with ${accountNumber.substring(accountNumber.length - 2)}`);
  return {
    accountNumber,
    txns,
  };
}

async function getAccountNumbers(page: Page): Promise<string[]> {
  return pageEvalAll(page, '[id$=lnkItem]', [], (elements) => elements.map((e) => (e as HTMLAnchorElement).text)).then((res) => res.map((text) => /\d+$/.exec(text.trim())?.[0] ?? ''));
}

async function setAccount(page: Page, account: string) {
  await pageEvalAll(
    page,
    '[id$=lnkItem]',
    null,
    (elements, account) => {
      for (const elem of elements) {
        const a = elem as HTMLAnchorElement;
        if (a.text.includes(account)) {
          a.click();
        }
      }
    },
    account,
  );
}

async function fetchTransactions(page: Page, startDate: Moment, scraperOptions: ScraperOptions): Promise<TransactionsAccount[]> {
  const accountNumbers: string[] = await getAccountNumbers(page);
  const accounts: TransactionsAccount[] = [];

  for (const account of accountNumbers) {
    debug(`setting account: ${account}`);
    await setAccount(page, account);
    await page.waitForTimeout(1000);
    accounts.push(
      await fetchTransactionsForAccount(
        page,
        startDate,
        account,
        scraperOptions,
      ),
    );
  }

  return accounts;
}

async function fetchFutureDebits(page: Page) {
  const futureDebitsSelector = '.homepage-banks-top';

  const result = await pageEvalAll(page, futureDebitsSelector, [], (items) => {
    const debitMountClass = 'amount';
    const debitWhenChargeClass = 'when-charge';
    const debitBankNumberClass = 'bankDesc';

    return items.map((currBankEl: any) => {
      const amount = currBankEl.getElementsByClassName(debitMountClass)[0].innerText;
      const whenCharge = currBankEl.getElementsByClassName(debitWhenChargeClass)[0].innerText;
      const bankNumber = currBankEl.getElementsByClassName(debitBankNumberClass)[0].innerText;
      return {
        amount,
        whenCharge,
        bankNumber,
      };
    });
  });
  const futureDebits = result.map((item) => {
    const amountData = getAmountData(item.amount);
    const chargeDate = /\d{1,2}[/]\d{2}[/]\d{2,4}/.exec(item.whenCharge)?.[0];
    const bankAccountNumber = /\d+-\d+/.exec(item.bankNumber)?.[0];
    return {
      amount: amountData.amount,
      amountCurrency: amountData.currency,
      chargeDate,
      bankAccountNumber,
    };
  });
  return futureDebits;
}

class VisaCalScraper extends BaseScraperWithBrowser {
  openLoginPopup = async () => {
    debug('open login popup, wait until login button available');
    await waitUntilElementFound(this.page, '#ccLoginDesktopBtn', true);
    debug('click on the login button');
    await clickButton(this.page, '#ccLoginDesktopBtn');
    debug('get the frame that holds the login');
    const frame = await getLoginFrame(this.page);
    debug('wait until the password login tab header is available');
    await waitUntilElementFound(frame, '#regular-login');
    debug('navigate to the password login tab');
    await clickButton(frame, '#regular-login');
    debug('wait until the password login tab is active');
    await waitUntilElementFound(frame, 'regular-login');

    return frame;
  };

  getLoginOptions(credentials: Record<string, string>) {
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'button[type="submit"]',
      possibleResults: getPossibleLoginResults(),
      checkReadiness: async () => waitUntilElementFound(this.page, '#ccLoginDesktopBtn'),
      preAction: this.openLoginPopup,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36',
    };
  }

  async fetchData(): Promise<ScaperScrapingResult> {
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));
    debug(`fetch transactions starting ${startMoment.format()}`);

    debug('fetch future debits');
    const futureDebits = await fetchFutureDebits(this.page);

    debug('navigate to transactions page');
    await this.navigateTo(TRANSACTIONS_URL, undefined, 60000);

    debug('fetch accounts transactions');
    const accounts = await fetchTransactions(this.page, startMoment, this.options);

    debug('return the scraped accounts');
    return {
      success: true,
      accounts,
      futureDebits,
    };
  }
}

export default VisaCalScraper;
