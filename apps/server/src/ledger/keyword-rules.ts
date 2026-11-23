/**
 * Built-in keyword rules (DESIGN 6.4 step 3): generic words and widely known
 * public chain/service names mapped to default category system keys. Longer
 * patterns win over shorter ones (priority = pattern length), so `쿠팡이츠`
 * beats `쿠팡`. `exact` is used where a short token would match too much.
 */
export interface KeywordRule {
  category: string;
  patterns: (string | { exact: string })[];
}

export const KEYWORD_RULES: KeywordRule[] = [
  {
    category: 'expense.living.convenience',
    patterns: ['GS25', 'CU편의점', { exact: 'CU' }, '세븐일레븐', '이마트24', '미니스톱', '편의점'],
  },
  {
    category: 'expense.food.cafe',
    patterns: [
      '스타벅스',
      'STARBUCKS',
      '이디야',
      '투썸플레이스',
      '메가커피',
      '메가MGC',
      '빽다방',
      '컴포즈커피',
      '폴바셋',
      '할리스',
      '커피빈',
      '카페',
      '커피',
      '베이커리',
      '파리바게뜨',
      '뚜레쥬르',
      '던킨',
      '배스킨라빈스',
    ],
  },
  { category: 'expense.food.delivery', patterns: ['배달의민족', '배민', '요기요', '쿠팡이츠'] },
  {
    category: 'expense.food.groceries',
    patterns: [
      '이마트',
      '홈플러스',
      '롯데마트',
      '코스트코',
      '하나로마트',
      '노브랜드',
      '식자재',
      '마트',
      '정육점',
      '청과',
    ],
  },
  {
    category: 'expense.food.dining',
    patterns: [
      '맥도날드',
      '버거킹',
      '롯데리아',
      'KFC',
      '맘스터치',
      '써브웨이',
      '김밥',
      '분식',
      '식당',
      '치킨',
      '피자',
      '국수',
      '냉면',
      '고기',
      '한식',
      '중식',
      '일식',
      '횟집',
    ],
  },
  {
    category: 'expense.transport.fuel',
    patterns: ['주유소', 'SK에너지', 'GS칼텍스', 'SOIL', '현대오일뱅크', '충전소'],
  },
  { category: 'expense.transport.taxi', patterns: ['택시', '카카오T', '카카오모빌리티'] },
  {
    category: 'expense.transport.public',
    patterns: ['티머니', '코레일', 'SRT', '지하철', '버스', '교통카드'],
  },
  { category: 'expense.transport.parking', patterns: ['주차', '하이패스', '도로공사'] },
  {
    category: 'expense.shopping.online',
    patterns: [
      '쿠팡',
      '11번가',
      'G마켓',
      '지마켓',
      '옥션',
      'SSG',
      '컬리',
      '위메프',
      '티몬',
      '알리익스프레스',
    ],
  },
  {
    category: 'expense.shopping.clothing',
    patterns: ['유니클로', '자라', 'ZARA', '무신사', '탑텐', '스파오'],
  },
  {
    category: 'expense.shopping.electronics',
    patterns: ['하이마트', '전자랜드', '이케아', 'IKEA', '가구'],
  },
  { category: 'expense.living.household', patterns: ['다이소'] },
  { category: 'expense.living.beauty', patterns: ['올리브영', '미용실', '헤어'] },
  { category: 'expense.health.pharmacy', patterns: ['약국'] },
  {
    category: 'expense.health.hospital',
    patterns: ['병원', '의원', '치과', '한의원', '내과', '소아과', '안과', '피부과'],
  },
  { category: 'expense.health.fitness', patterns: ['헬스', '필라테스', '요가'] },
  {
    category: 'expense.housing.telecom',
    patterns: ['SK텔레콤', 'LGU', 'LG유플러스', { exact: 'KT' }, 'KT통신'],
  },
  { category: 'expense.housing.utilities', patterns: ['한국전력', '도시가스', '수도요금'] },
  { category: 'expense.housing.maintenance', patterns: ['관리비'] },
  {
    category: 'expense.leisure.subscription',
    patterns: [
      '넷플릭스',
      'NETFLIX',
      '유튜브',
      'YOUTUBE',
      '멜론',
      '왓챠',
      '디즈니플러스',
      '티빙',
      '웨이브',
      '스포티파이',
      'SPOTIFY',
    ],
  },
  { category: 'expense.leisure.entertainment', patterns: ['CGV', '메가박스', '롯데시네마'] },
  { category: 'expense.leisure.travel', patterns: ['호텔', '모텔', '펜션', '리조트', '항공'] },
  {
    category: 'expense.education.books',
    patterns: ['교보문고', '예스24', 'YES24', '알라딘', '영풍문고', '서점'],
  },
  { category: 'expense.education.academy', patterns: ['학원'] },
  { category: 'expense.finance.insurance', patterns: ['보험'] },
];
