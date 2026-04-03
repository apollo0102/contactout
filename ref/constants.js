// CONTACTOUT_PASSWORD=Glo123456!
const SEARCH_COUNTRY_LIST = ["United States"]

const SEARCH_ROLE_LIST = ["Project Manager", "Operations Manager", "Sales Manager", "Marketing Manager", "Finance Manager", "Accounting Manager", "HR Manager", "Customer Success Manager", "Business Development Manager", "IT Manager", "Compliance Manager"]

//First priority in search
const SEARCH_GENDER_LIST = ["Male", "Female", "Unknown"]

//Second priority in search
// Years in current role // 0: 0-2 years, 1: 2-4 years, 2: 4-6 years, 3: 6-8 years 4: 8- 10 years 5: 10+years
const SEARCH_YEARS = [0,1,2,3,4,5]

//Third priority in search
//Total years of experience // 0_1: less than 1 year, 1_2: 1-2 years, 3_5: 3-5 years, 6_10: 6-10 years, 10_9999: more than 10 years
const SEARCH_TOTALYEARS = ["0_1", "1_2", "3-5", "6_10", "10_9999"]

//Fourth priority in search
//employee_size // 1-10: 1_10, 11-50: 11_50, 51-200:51_200, 201-500: 201_500, 501-1000: 501_1000, 1001-5000: 1001_5000, 5001-10000: 5001_10000, 10000+: 10001
const SEARCH_EMPLOYEE_SIZE = ["1_10", "11_50", "51_200", "201_500", "501_1000", "1001_5000", "5001_10000", "10001"]

//Fifth priority in search
//revenue range: $0-$1M : {revenue_min:0, revenue_max:1000}, $1M-$5M : {revenue_min:1000, revenue_max:5000}, $5M-$10M : {revenue_min:5000, revenue_max:10000}, $10M-$50M : {revenue_min:10000, revenue_max:50000}, $50M-$100M : {revenue_min:50000, revenue_max:100000}, $100M-$250M : {revenue_min:100000, revenue_max:250000}, $250M-$500M : {revenue_min:250000, revenue_max:500000}, $500M-$1B : {revenue_min:500000, revenue_max:1000000}, $1B-: {revenue_min:1000000}

const SEARCH_REVENUE = [
    { revenue_min: 0, revenue_max: 1000 },
    { revenue_min: 1000, revenue_max: 5000 },
    { revenue_min: 5000, revenue_max: 10000 },
    { revenue_min: 10000, revenue_max: 50000 },
    { revenue_min: 50000, revenue_max: 100000 },
    { revenue_min: 100000, revenue_max: 250000 },
    { revenue_min: 250000, revenue_max: 500000 },
    { revenue_min: 500000, revenue_max: 1000000 },
    
    { revenue_min: 1000000, revenue_max: 5000000 },
    { revenue_min: 5000000, revenue_max: 10000000 },
    { revenue_min: 10000000, revenue_max: 50000000 },
    { revenue_min: 50000000, revenue_max: 100000000 },
    { revenue_min: 100000000, revenue_max: 500000000 },
    { revenue_min: 500000000, revenue_max: 1000000000 },
    { revenue_min: 1000000000 }
]

//Sixth priority in search
//industry
const SEARCH_INDUSTRY = [
    "Accounting",
    "Airlines/Aviation",
    "Alternative Dispute Resolution",
    "Alternative Medicine",
    "Animation",
    "Apparel & Fashion",
    "Architecture & Planning",
    "Arts & Crafts",
    "Automotive",
    "Aviation & Aerospace",
    "Banking",
    "Biotechnology",
    "Broadcast Media",
    "Building Materials",
    "Business Supplies & Equipment",
    "Capital Markets",
    "Chemicals",
    "Civic & Social Organization",
    "Civil Engineering",
    "Commercial Real Estate",
    "Computer & Network Security",
    "Computer Games",
    "Computer Hardware",
    "Computer Networking",
    "Computer Software",
    "Construction",
    "Consumer Electronics",
    "Consumer Goods",
    "Consumer Services",
    "Cosmetics",
    "Dairy",
    "Defense & Space",
    "Design",
    "E-learning",
    "Education Management",
    "Electrical & Electronic Manufacturing",
    "Entertainment",
    "Environmental Services",
    "Events Services",
    "Executive Office",
    "Facilities Services",
    "Farming",
    "Financial Services",
    "Fine Art",
    "Fishery",
    "Food & Beverages",
    "Food Production",
    "Fundraising",
    "Furniture",
    "Gambling & Casinos",
    "Glass, Ceramics & Concrete",
    "Government Administration",
    "Government Relations",
    "Graphic Design",
    "Health, Wellness & Fitness",
    "Higher Education",
    "Hospital & Health Care",
    "Hospitality",
    "Human Resources",
    "Import & Export",
    "Individual & Family Services",
    "Industrial Automation",
    "Information Services",
    "Information Technology & Services",
    "Insurance",
    "International Affairs",
    "International Trade & Development",
    "Internet",
    "Investment Banking",
    "Investment Management",
    "Judiciary",
    "Law Enforcement",
    "Law Practice",
    "Legal Services",
    "Legislative Office",
    "Leisure, Travel & Tourism",
    "Libraries",
    "Logistics & Supply Chain",
    "Luxury Goods & Jewelry",
    "Machinery",
    "Management Consulting",
    "Maritime",
    "Market Research",
    "Marketing & Advertising",
    "Mechanical Or Industrial Engineering",
    "Media Production",
    "Medical Devices",
    "Medical Practice",
    "Mental Health Care",
    "Military",
    "Mining & Metals",
    "Motion Pictures & Film",
    "Museums & Institutions",
    "Music",
    "Nanotechnology",
    "Newspapers",
    "Non-profit Organization Management",
    "Oil & Energy",
    "Online Media",
    "Outsourcing/Offshoring",
    "Package/Freight Delivery",
    "Packaging & Containers",
    "Paper & Forest Products",
    "Performing Arts",
    "Pharmaceuticals",
    "Philanthropy",
    "Photography",
    "Plastics",
    "Political Organization",
    "Primary/Secondary Education",
    "Printing",
    "Professional Training & Coaching",
    "Program Development",
    "Public Policy",
    "Public Relations & Communications",
    "Public Safety",
    "Publishing",
    "Railroad Manufacture",
    "Ranching",
    "Real Estate",
    "Recreational Facilities & Services",
    "Religious Institutions",
    "Renewables & Environment",
    "Research",
    "Restaurants",
    "Retail",
    "Security & Investigations",
    "Semiconductors",
    "Shipbuilding",
    "Sporting Goods",
    "Sports",
    "Staffing & Recruiting",
    "Supermarkets",
    "Telecommunications",
    "Textiles",
    "Think Tanks",
    "Tobacco",
    "Translation & Localization",
    "Transportation/Trucking/Railroad",
    "Utilities",
    "Venture Capital & Private Equity",
    "Veterinary",
    "Warehousing",
    "Wholesale",
    "Wine & Spirits",
    "Wireless",
    "Writing & Editing"
]


const MAX_PAGES = 100
const PROXIES_FILE = "./ref/proxies.txt"
const PROXY_ROTATE_EVERY = 5
const EMPTY_PAGE_RETRY_MAX = 3
const PROXY_429_SLEEP_AFTER_SWAP_MS = 3000
const EMAIL_429_COOLDOWN_HOURS = 24
// START_PAGE=10
const PROXY_HEALTH_CHECK = 1;
const PROXY_HEALTH_CHECK_URL = "https://www.google.com/generate_204";
const PROXY_HEALTH_TIMEOUT_MS = 25000;
const PROXY_EXHAUSTED_RETRY_MS = 60000;
const PROXY_EXHAUSTED_MAX_WAIT_MS = 0;
const PROXY_VALIDATE_ON_START = 1;
const PROXY_VALIDATE_CONCURRENCY = 5;


const JSON_MERGE_COUNT = 10
const MERGED_DIRECTORY="./data/merged"
const RAPID_API_EMAIL_FINDER="59620721c8msh68873a42a2df9cfp193314jsnd519123e0bfc"
const RAPID_API_EMAIL_FINDER_LIST=["59620721c8msh68873a42a2df9cfp193314jsnd519123e0bfc", "59620721c8msh68873a42a2df9cfp193314jsnd519123e0bfc"]
const TRUELIST_API_KEYS=[
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImEwMmEyMzA5LTIzNzktNDMzYy05NmU4LTI3OWMzMTVlNjI1ZSIsImV4cGlyZXNfYXQiOm51bGx9.aol07hKqYXicOlTYOzJ0Jgn9dNSSftM6C6ADG16sFT4",
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImQ3N2JhYzJmLWVjMTEtNDY4MS05Y2VlLTVlNjdjMDc0MWJiZiIsImV4cGlyZXNfYXQiOm51bGx9.ZwbkXT5SSeHS3vfSyPpGfK7edLTeVZpbo3td-8cElq4",
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImJlOGQzNTY1LWE2MDgtNDc2OC04ZTdiLTU3NDUzMGY4NDQxYSIsImV4cGlyZXNfYXQiOm51bGx9.8lc2hCZJ08skZOZiE2bdT62-FstRQXNON18YFVikBGs",
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImIyNTllY2Q1LWE3ZjktNDI1ZS04ODVkLTA1ODNmMDI2MDdlOSIsImV4cGlyZXNfYXQiOm51bGx9.AJDksitf3z9PeXLoLR2fPvtKf6ggFEARxwYZMWdg_30",
    "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Ijc2MDBhNDc0LThmN2YtNDQwMy1hYmJjLThjNjk3N2JiN2E2NSIsImV4cGlyZXNfYXQiOm51bGx9.wqx99CyXHzWTu5Uvht57MWSv1dhwDWzrFk4mXgU1zv0"
]

const BANNED_WEBSITE_DOMAIN=
['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr',
'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
'aol.com', 'mail.com', 'protonmail.com', 'proton.me',
'icloud.com', 'me.com', 'mac.com',
'zoho.com', 'yandex.com', 'gmx.com', 'mail.ru', '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.org',
'throwaway.email', 'temp-mail.org', 'yopmail.com', 'getnada.com',
"tempmail.com", "throwaway.com", "mailinator.com", "10minutemail.com",
"guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
"sharklasers.com", "spam4.me", "grr.la", "guerrillamailblock.com",
"pokemail.net", "spam.la", "maildrop.cc", "yopmail.com", "yopmail.fr",
"trashmail.com", "trashmail.net", "fakeinbox.com", "tempinbox.com",
"discard.email", "throwawaymail.com", "getnada.com", "emailondeck.com",
"tempail.com", "tempmailaddress.com", "burnermail.io", "mytrashmail.com",
"33mail.com", "temp-mail.org", "10minemail.com", "dropmail.me",
"mohmal.com", "guerrilla-mail.com", "crazymailing.com", "tempr.email",
"dispostable.com", "fakemail.net", "inboxkitten.com", "minutemail.com"
]

const MAX_BROWSER_COUNT=3
const WORKER_DEAD_SLOT_LOG_INTERVAL_MS = 30000

export default {
    SEARCH_COUNTRY_LIST,
    SEARCH_ROLE_LIST,
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
    EMAIL_429_COOLDOWN_HOURS,
    PROXY_HEALTH_CHECK,
    PROXY_HEALTH_CHECK_URL,
    PROXY_HEALTH_TIMEOUT_MS,
    PROXY_EXHAUSTED_RETRY_MS,
    PROXY_EXHAUSTED_MAX_WAIT_MS,
    PROXY_VALIDATE_ON_START,
    PROXY_VALIDATE_CONCURRENCY,
    JSON_MERGE_COUNT,
    MERGED_DIRECTORY,
    RAPID_API_EMAIL_FINDER,
    TRUELIST_API_KEYS,
    BANNED_WEBSITE_DOMAIN,
    MAX_BROWSER_COUNT,
    WORKER_DEAD_SLOT_LOG_INTERVAL_MS,
    RAPID_API_EMAIL_FINDER_LIST
};
