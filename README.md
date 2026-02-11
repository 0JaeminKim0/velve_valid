# Valve Pricing AI Agent

밸브재 가격 분석 AI Agent - 조선업 밸브 구매가격 검증 시스템

## 🚀 실행 방법

### 로컬 개발
```bash
npm install
npm run dev
```

### 프로덕션 빌드
```bash
npm run build
npm start
```

## 📦 Railway 배포

### 환경변수 설정
- `ANTHROPIC_API_KEY`: Claude API 키 (AI 코멘트 생성용)
- `PORT`: 서버 포트 (Railway가 자동 설정)

### 배포 명령어
Railway CLI 또는 GitHub 연동으로 자동 배포

## 🔧 기술 스택
- **Backend**: Hono + Node.js + TypeScript
- **Frontend**: HTML + TailwindCSS + Chart.js
- **Data**: xlsx 라이브러리로 Excel 직접 파싱
- **AI**: Anthropic Claude API

## 📊 분석 단계
1. **Step 0**: 데이터 로딩
2. **Step 1**: 데이터 전처리
3. **Step A-1**: 계약단가 기준 추천가 산출
4. **Step A-2**: 발주실적 기준 예상가 산출
5. **Step B-1**: 견적 vs 계약단가 비교
6. **Step B-2**: 견적 vs 발주실적 비교
7. **Step B-3**: 가격 적정성 판정
8. **Step B-4**: AI 분석 코멘트 생성
9. **Step C**: 시황 대비 가격 분석
10. **Step C-1**: AI 시황 종합 리포트
