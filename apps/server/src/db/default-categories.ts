import type { CategoryKind } from '@budget/shared';

export interface DefaultCategory {
  /** Stable identifier; never change once released, it is how seeding stays idempotent. */
  key: string;
  name: string;
  children: { key: string; name: string }[];
}

/** Default two-level Korean categories, seeded on startup. */
export const DEFAULT_CATEGORIES: Record<CategoryKind, DefaultCategory[]> = {
  expense: [
    {
      key: 'food',
      name: '식비',
      children: [
        { key: 'dining', name: '외식' },
        { key: 'groceries', name: '장보기' },
        { key: 'delivery', name: '배달' },
        { key: 'cafe', name: '카페·간식' },
      ],
    },
    {
      key: 'living',
      name: '생활',
      children: [
        { key: 'household', name: '생활용품' },
        { key: 'convenience', name: '편의점' },
        { key: 'beauty', name: '미용' },
      ],
    },
    {
      key: 'housing',
      name: '주거·통신',
      children: [
        { key: 'maintenance', name: '관리비' },
        { key: 'utilities', name: '공과금' },
        { key: 'rent', name: '월세·대출이자' },
        { key: 'telecom', name: '통신비' },
      ],
    },
    {
      key: 'transport',
      name: '교통·차량',
      children: [
        { key: 'public', name: '대중교통' },
        { key: 'taxi', name: '택시' },
        { key: 'fuel', name: '주유·충전' },
        { key: 'parking', name: '주차·통행료' },
        { key: 'car', name: '차량 관리' },
      ],
    },
    {
      key: 'shopping',
      name: '쇼핑',
      children: [
        { key: 'clothing', name: '의류·잡화' },
        { key: 'online', name: '온라인쇼핑' },
        { key: 'electronics', name: '가전·가구' },
      ],
    },
    {
      key: 'health',
      name: '의료·건강',
      children: [
        { key: 'hospital', name: '병원' },
        { key: 'pharmacy', name: '약국' },
        { key: 'fitness', name: '운동' },
      ],
    },
    {
      key: 'education',
      name: '교육',
      children: [
        { key: 'academy', name: '학원·수업' },
        { key: 'books', name: '도서' },
      ],
    },
    {
      key: 'children',
      name: '육아',
      children: [
        { key: 'goods', name: '육아용품' },
        { key: 'allowance', name: '용돈' },
      ],
    },
    {
      key: 'leisure',
      name: '문화·여가',
      children: [
        { key: 'entertainment', name: '영화·공연' },
        { key: 'travel', name: '여행·숙박' },
        { key: 'hobby', name: '취미' },
        { key: 'subscription', name: '구독 서비스' },
      ],
    },
    {
      key: 'events',
      name: '경조사·선물',
      children: [
        { key: 'occasions', name: '경조사' },
        { key: 'gifts', name: '선물' },
      ],
    },
    {
      key: 'finance',
      name: '금융·보험',
      children: [
        { key: 'insurance', name: '보험' },
        { key: 'tax', name: '세금' },
        { key: 'fees', name: '수수료' },
      ],
    },
    {
      key: 'pets',
      name: '반려동물',
      children: [{ key: 'care', name: '사료·용품·병원' }],
    },
    {
      key: 'other',
      name: '기타 지출',
      children: [{ key: 'misc', name: '기타' }],
    },
  ],
  income: [
    {
      key: 'salary',
      name: '근로소득',
      children: [
        { key: 'wage', name: '급여' },
        { key: 'bonus', name: '상여금' },
      ],
    },
    {
      key: 'side',
      name: '부수입',
      children: [
        { key: 'business', name: '사업·부업' },
        { key: 'resale', name: '중고 판매' },
      ],
    },
    {
      key: 'financial',
      name: '금융소득',
      children: [
        { key: 'interest', name: '이자' },
        { key: 'dividend', name: '배당' },
      ],
    },
    {
      key: 'other',
      name: '기타 수입',
      children: [
        { key: 'refund', name: '환급' },
        { key: 'gift', name: '용돈·선물' },
        { key: 'misc', name: '기타' },
      ],
    },
  ],
};
