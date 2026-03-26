//  EMAIL_USER=dev@glotanning.com
// CONTACTOUT_PASSWORD=Glo123456

// EMAIL_USER1=decentdev001@outlook.com
// EMAIL_USER2=decentdev002@outlook.com
// EMAIL_USER3=decentdev003@outlook.com

// EMAIL_USER1=twin.rabbit0617@gmail.com
// EMAIL_USER2=tainuepolob@gmail.com
// EMAIL_USER3=isbsusigu@gmail.com
// CONTACTOUT_PASSWORD=Sharkham617@

// CONTACTOUT_PASSWORD=Glo123456!
const SEARCH_KEYWORD = "United States"
// SEARCH_TITLE="Director of Strategy"
const SEARCH_TITLE = "Engineer"
//First priority in search
const SEARCH_GENDER_LIST = ["Male"]

//Second priority in search
// Years in current role // 0: 0-2 years, 1: 2-4 years, 2: 4-6 years, 3: 6-8 years 4: 8- 10 years 5: 10+years
const SEARCH_YEARS = [0]

//Third priority in search
//Total years of experience // 0_1: less than 1 year, 1_2: 1-2 years, 3_5: 3-5 years, 6_10: 6-10 years, 10_9999: more than 10 years
const SEARCH_TOTALYEARS = ["10_9999"]

//Fourth priority in search
//employee_size // 1-10: 1_10, 11-50: 11_50, 51-200:51_200, 201-500: 201_500, 501-1000: 501_1000, 1001-5000: 1001_5000, 5001-10000: 5001_10000, 10000+: 10001
const SEARCH_EMPLOYEE_SIZE = ["10001"]

//Fifth priority in search
//revenue range: $0-$1M : {revenue_min:0, revenue_max:1000}, $1M-$5M : {revenue_min:1000, revenue_max:5000}, $5M-$10M : {revenue_min:5000, revenue_max:10000}, $10M-$50M : {revenue_min:10000, revenue_max:50000}, $50M-$100M : {revenue_min:50000, revenue_max:100000}, $100M-$250M : {revenue_min:100000, revenue_max:250000}, $250M-$500M : {revenue_min:250000, revenue_max:500000}, $500M-$1B : {revenue_min:500000, revenue_max:1000000}, $1B-: {revenue_min:1000000}

const SEARCH_REVENUE = [
    // { revenue_min: 0, revenue_max: 1000 },
    // { revenue_min: 1000, revenue_max: 5000 },
    // { revenue_min: 5000, revenue_max: 10000 },
    // { revenue_min: 10000, revenue_max: 50000 },
    // { revenue_min: 50000, revenue_max: 100000 },
    // { revenue_min: 100000, revenue_max: 250000 },
    // { revenue_min: 250000, revenue_max: 500000 },
    // { revenue_min: 500000, revenue_max: 1000000 },
    { revenue_min: 1000000 }
]

//Sixth priority in search
//industry
const SEARCH_INDUSTRY = [
    "Defense & Space", "Computer Hardware", "Computer Software", "Computer Networking", "Internet"
]


const MAX_PAGES = 2
const PROXIES_FILE = "./ref/proxies.txt"
const PROXY_ROTATE_EVERY = 5
const EMPTY_PAGE_RETRY_MAX = 3
const PROXY_429_SLEEP_AFTER_SWAP_MS = 3000
// START_PAGE=10

export default {
    SEARCH_KEYWORD,
    SEARCH_TITLE,
    SEARCH_GENDER_LIST,
    SEARCH_YEARS,
    SEARCH_TOTALYEARS,
    SEARCH_EMPLOYEE_SIZE,
    SEARCH_REVENUE,
    SEARCH_INDUSTRY,
    MAX_PAGES,
    PROXIES_FILE,
    PROXY_ROTATE_EVERY,
    EMPTY_PAGE_RETRY_MAX,
    PROXY_429_SLEEP_AFTER_SWAP_MS,
};
