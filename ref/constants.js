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
// SEARCH_ROLE="Director of Strategy"
const SEARCH_ROLE = "Director of Strategy"
//First priority in search
const SEARCH_GENDER_LIST = ["Male", "Female", "Unknown"]

//Second priority in search
// Years in current role // 0: 0-2 years, 1: 2-4 years, 2: 4-6 years, 3: 6-8 years 4: 8- 10 years 5: 10+years
const SEARCH_YEARS = [0, 1, 2, 3, 4, 5]

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
    { revenue_min: 1000000 }
]

//Sixth priority in search
//industry
const SEARCH_INDUSTRY = [
    // "Defense & Space", "Computer Hardware", "Computer Software", "Computer Networking", "Internet"
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
// START_PAGE=10
const PROXY_HEALTH_CHECK = 0;
const PROXY_HEALTH_CHECK_URL = "https://contactout.com/";
const PROXY_HEALTH_TIMEOUT_MS = 25000;

export default {
    SEARCH_KEYWORD,
    SEARCH_ROLE,
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
    PROXY_HEALTH_CHECK,
    PROXY_HEALTH_CHECK_URL,
    PROXY_HEALTH_TIMEOUT_MS,
};
