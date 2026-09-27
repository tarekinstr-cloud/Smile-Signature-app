# Smile Signature — تطبيق تسيير المطعم (PWA)

React + TypeScript + Vite + Supabase.

## المرحلة 1 — الجزء 1: الصالات والطاولات
- عدة صالات، كل صالة بمقاسها (عرض × طول بوحدات منطقية، الافتراضي 1000 × 640).
- طاولات بمواقع X/Y، عدد مقاعد، شكل (مربعة / دائرية / مستطيلة) وحجم.
- حالة كل طاولة: حرة / مشغولة، مع عدّاد لكل صالة.
- **وضع الخدمة**: الضغط على طاولة يبدّل حالتها.
- **وضع تعديل المخطط**: سحب وإفلات الطاولات (فأرة أو لمس، مع شبكة 10)، إضافة/حذف/تعديل الطاولات والصالات.
- تحديث مباشر (Realtime) بين كل الأجهزة عند ربط Supabase.

## التشغيل
```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # نسخة الإنتاج في dist/ (مع Service Worker و manifest)
```
بدون ملف `.env` يعمل التطبيق في **وضع تجريبي**: البيانات تُحفظ في المتصفح على هذا الجهاز فقط.

## ربط Supabase
1. أنشئ مشروعاً في https://supabase.com/dashboard باسم `smile-signature-app`.
2. في **SQL Editor** نفّذ محتوى `supabase/migrations/20260927000000_halls_tables.sql`، ثم (اختياري) `supabase/seed.sql` لبيانات تجريبية.
3. في **Authentication → Users** أضف مستخدماً للطاقم (بريد + كلمة سر).
4. انسخ `.env.example` إلى `.env` وضع فيه `Project URL` و `anon public key` من **Project Settings → API**.

أو عبر Supabase CLI: `supabase link --project-ref <ref>` ثم `supabase db push`.

## الأمان (RLS)
الجداول محمية بـ Row Level Security: فقط المستخدمون المسجّلون يقرؤون ويعدّلون. الأدوار (مدير / نادل / كاسيير) تأتي لاحقاً.

## البنية
```
src/lib/repo.ts            طبقة البيانات (Supabase أو التخزين المحلي)
src/components/FloorPlan   المخطط + السحب والإفلات
src/components/FloorScreen الشاشة الرئيسية (الصالات، الأوضاع)
src/components/TablePanel  تعديل طاولة
src/components/HallPanel   تعديل صالة
supabase/migrations        مخطط قاعدة البيانات
```
