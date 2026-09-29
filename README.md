# Smile Signature — تطبيق تسيير المطعم (PWA)

React + TypeScript + Vite + Supabase.

## المرحلة 1 — الجزء 1: الصالات والطاولات
- عدة صالات، كل صالة بمقاسها (عرض × طول بوحدات منطقية، الافتراضي 1000 × 640).
- طاولات بمواقع X/Y، عدد مقاعد، شكل (مربعة / دائرية / مستطيلة) وحجم.
- حالة كل طاولة: حرة / مشغولة، مع عدّاد لكل صالة.
- **وضع الخدمة**: الضغط على طاولة يبدّل حالتها.
- **وضع تعديل المخطط**: سحب وإفلات الطاولات (فأرة أو لمس، مع شبكة 10)، إضافة/حذف/تعديل الطاولات والصالات.
- تحديث مباشر (Realtime) بين كل الأجهزة عند ربط Supabase.

## المرحلة 1 — الجزء 2: الطلبات
- في **وضع الخدمة**، الضغط على طاولة يفتح شاشة طلبها: الفئات في الأعلى، والأصناف تحتها، والطلب الحالي على الجانب (أو أسفل الشاشة في الهاتف).
- صنف بدون خيارات يُضاف بضغطة واحدة؛ صنف له خيارات (الحجم، إضافات…) يفتح نافذة لاختيارها مع الكمية وملاحظة.
- تعديل الكمية (+ / −)، ملاحظة على كل سطر (بالضغط على اسمه)، والمجموع بالدينار الجزائري (DA / دج).
- أول صنف يفتح طلباً ويجعل الطاولة **مشغولة**؛ إلغاء الطلب يحرّرها. طلب مفتوح واحد فقط لكل طاولة.
- الاسم والسعر والخيارات تُنسخ في سطر الطلب، فلا يتغيّر طلب قديم إذا تغيّرت القائمة.

## إدارة القائمة (من داخل التطبيق)
- زر **القائمة** في الشريط العلوي يفتح شاشة الإدارة.
- الفئات: إضافة، تغيير الاسم واللون، ترتيب (▲ ▼)، إخفاء من شاشة الطلب، أو حذف.
- الأصناف: إضافة، تعديل الاسم والسعر، نقل إلى فئة أخرى، ترتيب، إخفاء أو حذف.
- الخيارات لكل صنف: مجموعات (مثلاً "الحجم" إجباري، "إضافات" حتى 3) وكل خيار بفرق سعره.
- تغيير سعر أو حذف صنف لا يغيّر الطلبات السابقة (الاسم والسعر منسوخان في سطر الطلب).
- حالياً كل مستخدم مسجّل من الطاقم يستطيع تعديل القائمة؛ تحديد ذلك للمدير يأتي مع الأدوار.

## المرحلة 1 — الجزء 3: الكاسيير (Caisse)
- **التحصيل** من شاشة الطلب (زر «Encaisser · المجموع»)، أو من المخطط: الضغط على طاولة مشغولة يعرض «Encaisser» أو «Voir la commande».
- **طريقة الدفع**: نقدي (Espèces) مع المبلغ المستلم وأزرار سريعة (المبلغ بالضبط، 200، 500، 1000…) وحساب الباقي، أو بطاقة (Carte).
- المجموع يُحسب في قاعدة البيانات من سطور الطلب (الدالة `checkout_order`)، والطلب يأخذ **رقم تذكرة** متسلسل.
- بعد التحصيل الطلب يصبح `paid` والطاولة ترجع **حرة** تلقائياً (نفس التريغر ديال الجزء 2).
- **التذكرة**: الشعار والاسم، العنوان/الهاتف، رقم التذكرة والتاريخ، الطاولة، الأصناف مع خياراتها، المجموع، طريقة الدفع (والمستلم والباقي في النقدي)، ورسالة شكر.
- زر **Imprimer** يطبع التذكرة وحدها بعرض 80 مم (طابعة تذاكر حرارية أو أي طابعة).
- زر **Personnaliser** يعدّل الاسم، الأسطر تحت الاسم ورسالة الختام (محفوظة في جدول `receipt_settings`).
- الشعار حالياً هو `public/icon.svg`؛ لتغييره يكفي استبدال هذا الملف.

## التشغيل
```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # نسخة الإنتاج في dist/ (مع Service Worker و manifest)
```
بدون ملف `.env` يعمل التطبيق في **وضع تجريبي**: البيانات تُحفظ في المتصفح على هذا الجهاز فقط.

## ربط Supabase
1. أنشئ مشروعاً في https://supabase.com/dashboard باسم `smile-signature-app`.
2. في **SQL Editor** نفّذ بالترتيب:
   - `supabase/migrations/20260927000000_halls_tables.sql`
   - `supabase/migrations/20260927010000_menu_orders.sql` (الفئات، الأصناف، الخيارات، الطلبات + قائمة تجريبية)
   - `supabase/migrations/20260927020000_checkout.sql` (التحصيل، رقم التذكرة، إعدادات التذكرة)
   - `supabase/migrations/20260928000000_kitchen.sql` (الطابعات، Valider، تذاكر المطبخ)
   - `supabase/migrations/20260928010000_payments.sql` (شاشة الدفع: دفع جزئي، تخفيض، مجاني)
   - `supabase/migrations/20260928020000_order_actions.sql` (barre d'actions: à emporter, changement de table + journal table_moves, facture)
   - `supabase/migrations/20260928030000_keep_order_table.sql` (une commande de table garde sa table: plus de passage à emporter, suppression d'une table occupée bloquée)
   - `supabase/migrations/20260928060000_back_office.sql` (back-office: stock_items + adjust_stock, suppliers, list_staff pour « Gestion des employés »)
   - `supabase/migrations/20260929000000_users_backup.sql` (menu Fichier: app_users + rôles, list_users / save_user, backups_log, logo du ticket)
   - `supabase/migrations/20260929010000_login.sql` (écran de connexion: login_users pour la liste déroulante, login_email pour se connecter avec le nom d'utilisateur)
   - `supabase/migrations/20260929020000_roles.sql` (rôles Admin / Employé, RLS: stock, fournisseurs, comptes, sauvegardes et modification du ticket réservés à l'admin)
   - `supabase/migrations/20260929030000_login_repair.sql` (réparation de la connexion par nom d'utilisateur: login_users / login_email, comptes confirmés, identités manquantes)
   - `supabase/migrations/20260930000000_permissions.sql` (permissions configurables: tables role_permissions / user_permissions, has_permission / my_permissions, RLS des sections et contrôle Annuler / Offrir / Remise)
   - (اختياري) `supabase/seed.sql` لطاولات تجريبية.
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
src/components/OrderScreen شاشة الطلب (الفئات، الأصناف، الطلب الحالي)
src/components/ItemOptionsDialog اختيار خيارات الصنف
src/components/CheckoutDialog التحصيل (نقدي / بطاقة، الباقي)
src/components/Receipt     التذكرة (للشاشة والطباعة)
src/components/ReceiptDialog عرض التذكرة، الطباعة والتخصيص
src/components/MenuAdmin   إدارة القائمة (الفئات والأصناف)
src/components/ItemEditor  تعديل صنف وسعره وخياراته
supabase/migrations        مخطط قاعدة البيانات
```

## اللغة والعملة
- الواجهة بالفرنسية (افتراضياً) أو بالعربية، بزر في الشريط العلوي (وفي شاشة الدخول). الاختيار يُحفظ على الجهاز.
- العربية تقلب الواجهة من اليمين لليسار؛ مخطط الصالة يبقى دائماً من اليسار لليمين.
- الأسعار بالدينار الجزائري: `DA` بالفرنسية و`دج` بالعربية. النصوص كلها في `src/lib/i18n.ts`.
