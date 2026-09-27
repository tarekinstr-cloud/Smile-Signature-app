import { useSyncExternalStore } from 'react'

export type Lang = 'fr' | 'ar'

const fr = {
  dir: 'ltr' as 'ltr' | 'rtl',
  currency: 'DA',
  listSep: ', ',
  switchTo: 'العربية',
  switchLabel: 'Changer de langue',

  loading: 'Chargement…',
  saving: 'Enregistrement…',
  cancel: 'Annuler',
  add: 'Ajouter',
  delete: 'Supprimer',
  save: 'Enregistrer',
  close: 'Fermer',
  back: '← Retour',
  backToFloor: 'Retour au plan',
  moveUp: 'Monter',
  moveDown: 'Descendre',
  decrease: 'Diminuer',
  increase: 'Augmenter',
  width: 'Largeur',
  height: 'Longueur',
  free: 'Libre',
  occupied: 'Occupée',

  // Login
  email: 'E-mail',
  password: 'Mot de passe',
  signIn: 'Connexion',
  badLogin: 'E-mail ou mot de passe incorrect',

  // Floor
  halls: 'Salles',
  addHall: 'Ajouter une salle',
  addHallTab: '+ Salle',
  mode: 'Mode',
  service: 'Service',
  editPlan: 'Modifier le plan',
  menu: 'Menu',
  menuTitle: 'Gérer les catégories, articles et prix',
  signOut: 'Déconnexion',
  demoBanner: 'Mode démo : les données sont enregistrées sur cet appareil uniquement tant que Supabase n’est pas connecté.',
  noHalls: 'Aucune salle pour le moment.',
  addFirstHall: 'Ajouter la première salle',
  freeCount: (n: number) => `Libres : ${n}`,
  occupiedCount: (n: number) => `Occupées : ${n}`,
  hintService: 'Touchez une table pour ouvrir sa commande ou l’encaisser',
  hintEdit: 'Glissez les tables pour les déplacer, touchez une table pour la modifier',
  addTable: '+ Table',
  newHallName: 'Nom de la nouvelle salle',
  confirmDeleteTable: (label: string) => `Supprimer la table ${label} ?`,
  confirmDeleteHall: (name: string) => `Supprimer la salle « ${name} » et toutes ses tables ?`,
  tableAria: (label: string, seats: number, free: boolean) =>
    `Table ${label}, ${seats} places, ${free ? 'libre' : 'occupée'}`,
  duplicateTable: (label: string) => `La table « ${label} » existe déjà dans cette salle`,

  // Hall panel
  hallSettings: 'Paramètres de la salle',
  hallHint: 'Choisissez une table pour la modifier, ou modifiez la salle ici.',
  hallName: 'Nom de la salle',
  deleteHall: 'Supprimer la salle',

  // Table panel
  table: (label: string) => `Table ${label}`,
  tableLabel: 'Numéro / nom',
  seats: 'Nombre de places',
  shape: 'Forme',
  square: 'Carrée',
  round: 'Ronde',
  rect: 'Rectangulaire',
  status: 'État',
  position: 'Position',
  deleteTable: 'Supprimer la table',

  // Order screen
  seatsCount: (n: number) => `${n} places`,
  openOrder: 'Commande ouverte',
  categories: 'Catégories',
  emptyMenu: 'Le menu est vide. Ajoutez les catégories et les articles depuis le bouton « Menu » de l’écran principal.',
  hasOptions: 'Options',
  noItemsInCategory: 'Aucun article dans cette catégorie.',
  order: 'Commande',
  itemCount: (n: number) => `${n} article${n > 1 ? 's' : ''}`,
  orderHint: 'Choisissez une catégorie puis touchez les articles pour les ajouter.',
  addNote: 'Ajouter une note',
  total: 'Total',
  cancelOrder: 'Annuler la commande',
  doneBack: 'Terminé, retour au plan',
  showOrder: 'Voir la commande',
  backToMenu: '← Ajouter des articles',
  added: (name: string) => `${name} ajouté`,
  noteFor: (name: string) => `Note pour « ${name} »`,
  confirmCancelOrder: (label: string) => `Annuler la commande de la table ${label} ? La table redeviendra libre.`,

  // Item options dialog
  required: 'Obligatoire',
  optional: 'Facultatif',
  upTo: (n: number) => `jusqu’à ${n}`,
  note: 'Note',
  notePlaceholder: 'Ex. : sans oignon',
  choose: 'Choisissez :',

  // Menu admin
  menuAdmin: 'Gestion du menu',
  menuAdminSub: 'Catégories, articles, prix et options',
  addCategory: '+ Catégorie',
  newCategoryName: 'Nom de la nouvelle catégorie',
  noCategories: 'Aucune catégorie pour le moment.',
  hiddenF: 'Masquée',
  hiddenM: 'Masqué',
  categoryName: 'Nom de la catégorie',
  color: 'Couleur',
  otherColor: 'Autre couleur',
  categoryVisible: 'Visible sur l’écran de commande',
  deleteCategory: 'Supprimer la catégorie',
  confirmDeleteCategory: (name: string, n: number) =>
    `Supprimer la catégorie « ${name} »${n ? ` et ses ${n} article${n > 1 ? 's' : ''}` : ''} ? Les anciennes commandes ne sont pas affectées. Vous pouvez aussi la masquer.`,
  itemsOf: (name: string) => `Articles de « ${name} »`,
  addItem: '+ Article',
  adminItemsHint: 'Touchez un article pour modifier son nom, son prix et ses options. Changer un prix ne modifie pas les commandes déjà ouvertes.',
  startWithCategory: 'Commencez par ajouter une catégorie (ex. : Boissons chaudes).',
  confirmDeleteItem: (name: string) => `Supprimer l’article « ${name} » ? Les anciennes commandes ne sont pas affectées.`,

  // Item editor
  editItem: (name: string) => `Modifier « ${name} »`,
  newItem: 'Nouvel article',
  name: 'Nom',
  price: (cur: string) => `Prix (${cur})`,
  category: 'Catégorie',
  itemVisible: 'Visible sur l’écran de commande',
  options: 'Options',
  addGroup: '+ Groupe d’options',
  noGroups: 'Aucune option : l’article s’ajoute à la commande en un seul geste. Ajoutez un groupe comme « Taille » ou « Suppléments ».',
  groupName: 'Nom du groupe',
  groupPlaceholder: 'Taille',
  deleteGroup: 'Supprimer le groupe',
  multiChoice: 'Choix multiple',
  upToLabel: 'Jusqu’à',
  optionName: 'Nom de l’option',
  priceDelta: 'Supplément de prix',
  deleteOption: 'Supprimer l’option',
  addOption: '+ Option',
  deltaHint: 'Le nombre à côté de chaque option s’ajoute au prix de l’article (0 = sans supplément).',
  deleteItem: 'Supprimer l’article',
  errName: 'Saisissez le nom de l’article.',
  errPrice: 'Prix incorrect.',
  errGroupName: 'Chaque groupe d’options a besoin d’un nom (ex. : Taille).',
  errGroupEmpty: (name: string) => `Ajoutez au moins une option dans « ${name} ».`,
  errDelta: (name: string) => `Le supplément de « ${name} » est incorrect.`,
  // Checkout
  checkout: 'Encaisser',
  checkoutTitle: (label: string) => `Encaisser la table ${label}`,
  amountDue: 'À payer',
  paymentMethod: 'Mode de paiement',
  cash: 'Espèces',
  card: 'Carte',
  received: 'Montant reçu',
  exact: 'Montant exact',
  change: 'Rendu',
  missingAmount: (s: string) => `Il manque ${s}`,
  confirmPayment: 'Valider le paiement',
  errOrderClosed: 'Cette commande est déjà fermée (encaissée ou annulée sur un autre appareil).',
  errOrderEmpty: 'La commande est vide.',
  errAmountTooLow: 'Le montant reçu est inférieur au total.',
  tableActions: (label: string) => `Table ${label}`,
  viewOrder: 'Voir / modifier la commande',
  checkoutAmount: (s: string) => `Encaisser · ${s}`,

  // Receipt
  receipt: 'Ticket',
  paid: 'Payé',
  ticketNo: (n: string) => `Ticket N° ${n}`,
  print: 'Imprimer',
  customize: 'Personnaliser',
  paidBy: 'Paiement',
  receiptSettings: 'Personnaliser le ticket',
  receiptName: 'Nom affiché',
  receiptHeader: 'Lignes sous le nom (adresse, téléphone…)',
  receiptFooter: 'Message de fin',
  receiptPreview: 'Aperçu',
  locale: 'fr-FR',
}

type Dict = typeof fr

const ar: Dict = {
  dir: 'rtl',
  currency: 'دج',
  listSep: '، ',
  switchTo: 'Français',
  switchLabel: 'تغيير اللغة',

  loading: 'جارٍ التحميل…',
  saving: 'جارٍ الحفظ…',
  cancel: 'إلغاء',
  add: 'إضافة',
  delete: 'حذف',
  save: 'حفظ',
  close: 'إغلاق',
  back: '→ رجوع',
  backToFloor: 'رجوع إلى المخطط',
  moveUp: 'للأعلى',
  moveDown: 'للأسفل',
  decrease: 'إنقاص',
  increase: 'زيادة',
  width: 'العرض',
  height: 'الطول',
  free: 'حرة',
  occupied: 'مشغولة',

  email: 'البريد الإلكتروني',
  password: 'كلمة السر',
  signIn: 'دخول',
  badLogin: 'البريد أو كلمة السر غير صحيحة',

  halls: 'الصالات',
  addHall: 'إضافة صالة',
  addHallTab: '+ صالة',
  mode: 'الوضع',
  service: 'الخدمة',
  editPlan: 'تعديل المخطط',
  menu: 'القائمة',
  menuTitle: 'إدارة الفئات والأصناف والأسعار',
  signOut: 'خروج',
  demoBanner: 'وضع تجريبي: البيانات محفوظة على هذا الجهاز فقط إلى أن يتم ربط Supabase.',
  noHalls: 'لا توجد صالات بعد.',
  addFirstHall: 'إضافة أول صالة',
  freeCount: (n) => `حرة: ${n}`,
  occupiedCount: (n) => `مشغولة: ${n}`,
  hintService: 'اضغط على طاولة لفتح طلبها أو تحصيلها',
  hintEdit: 'اسحب الطاولات لتحريكها، واضغط على طاولة لتعديلها',
  addTable: '+ طاولة',
  newHallName: 'اسم الصالة الجديدة',
  confirmDeleteTable: (label) => `حذف الطاولة ${label}؟`,
  confirmDeleteHall: (name) => `حذف الصالة "${name}" وكل طاولاتها؟`,
  tableAria: (label, seats, free) => `طاولة ${label}، ${seats} مقاعد، ${free ? 'حرة' : 'مشغولة'}`,
  duplicateTable: (label) => `الطاولة "${label}" موجودة من قبل في هذه الصالة`,

  hallSettings: 'إعدادات الصالة',
  hallHint: 'اختر طاولة لتعديلها، أو عدّل الصالة هنا.',
  hallName: 'اسم الصالة',
  deleteHall: 'حذف الصالة',

  table: (label) => `طاولة ${label}`,
  tableLabel: 'الرقم / الاسم',
  seats: 'عدد المقاعد',
  shape: 'الشكل',
  square: 'مربعة',
  round: 'دائرية',
  rect: 'مستطيلة',
  status: 'الحالة',
  position: 'الموقع',
  deleteTable: 'حذف الطاولة',

  seatsCount: (n) => `${n} مقاعد`,
  openOrder: 'طلب مفتوح',
  categories: 'الفئات',
  emptyMenu: 'القائمة فارغة. أضف الفئات والأصناف من زر «القائمة» في الشاشة الرئيسية.',
  hasOptions: 'خيارات',
  noItemsInCategory: 'لا توجد أصناف في هذه الفئة.',
  order: 'الطلب',
  itemCount: (n) => `${n} صنف`,
  orderHint: 'اختر فئة ثم اضغط على الأصناف لإضافتها.',
  addNote: 'إضافة ملاحظة',
  total: 'المجموع',
  cancelOrder: 'إلغاء الطلب',
  doneBack: 'تم، الرجوع للمخطط',
  showOrder: 'عرض الطلب',
  backToMenu: '→ إضافة أصناف',
  added: (name) => `تمت إضافة ${name}`,
  noteFor: (name) => `ملاحظة على "${name}"`,
  confirmCancelOrder: (label) => `إلغاء طلب الطاولة ${label}؟ ستصبح الطاولة حرة.`,

  required: 'إجباري',
  optional: 'اختياري',
  upTo: (n) => `حتى ${n}`,
  note: 'ملاحظة',
  notePlaceholder: 'مثلاً: بدون بصل',
  choose: 'اختر:',

  menuAdmin: 'إدارة القائمة',
  menuAdminSub: 'الفئات، الأصناف، الأسعار والخيارات',
  addCategory: '+ فئة',
  newCategoryName: 'اسم الفئة الجديدة',
  noCategories: 'لا توجد فئات بعد.',
  hiddenF: 'مخفية',
  hiddenM: 'مخفي',
  categoryName: 'اسم الفئة',
  color: 'اللون',
  otherColor: 'لون آخر',
  categoryVisible: 'تظهر في شاشة الطلب',
  deleteCategory: 'حذف الفئة',
  confirmDeleteCategory: (name, n) =>
    `حذف الفئة "${name}"${n ? ` و${n} صنف فيها` : ''}؟ الطلبات القديمة لا تتأثر. يمكنك بدلاً من ذلك إخفاؤها.`,
  itemsOf: (name) => `أصناف "${name}"`,
  addItem: '+ صنف',
  adminItemsHint: 'اضغط على صنف لتعديل اسمه وسعره وخياراته. تغيير السعر لا يغيّر الطلبات المفتوحة من قبل.',
  startWithCategory: 'ابدأ بإضافة فئة (مثلاً: مشروبات ساخنة).',
  confirmDeleteItem: (name) => `حذف الصنف "${name}"؟ الطلبات القديمة لا تتأثر.`,

  editItem: (name) => `تعديل "${name}"`,
  newItem: 'صنف جديد',
  name: 'الاسم',
  price: (cur) => `السعر (${cur})`,
  category: 'الفئة',
  itemVisible: 'يظهر في شاشة الطلب',
  options: 'الخيارات',
  addGroup: '+ مجموعة خيارات',
  noGroups: 'لا خيارات: الصنف يُضاف للطلب بضغطة واحدة. أضف مجموعة مثل "الحجم" أو "إضافات".',
  groupName: 'اسم المجموعة',
  groupPlaceholder: 'الحجم',
  deleteGroup: 'حذف المجموعة',
  multiChoice: 'عدة اختيارات',
  upToLabel: 'حتى',
  optionName: 'اسم الخيار',
  priceDelta: 'فرق السعر',
  deleteOption: 'حذف الخيار',
  addOption: '+ خيار',
  deltaHint: 'الرقم بجانب كل خيار هو ما يُضاف إلى سعر الصنف (0 = بدون زيادة).',
  deleteItem: 'حذف الصنف',
  errName: 'اكتب اسم الصنف.',
  errPrice: 'السعر غير صحيح.',
  errGroupName: 'كل مجموعة خيارات تحتاج اسماً (مثلاً: الحجم).',
  errGroupEmpty: (name) => `أضف خياراً واحداً على الأقل في "${name}".`,
  errDelta: (name) => `فرق السعر لـ "${name}" غير صحيح.`,
  checkout: 'تحصيل',
  checkoutTitle: (label) => `تحصيل الطاولة ${label}`,
  amountDue: 'المبلغ المطلوب',
  paymentMethod: 'طريقة الدفع',
  cash: 'نقدي',
  card: 'بطاقة',
  received: 'المبلغ المستلم',
  exact: 'المبلغ بالضبط',
  change: 'الباقي',
  missingAmount: (s) => `ناقص ${s}`,
  confirmPayment: 'تأكيد الدفع',
  errOrderClosed: 'هذا الطلب مغلق من قبل (تحصّل أو تلغى من جهاز آخر).',
  errOrderEmpty: 'الطلب فارغ.',
  errAmountTooLow: 'المبلغ المستلم أقل من المجموع.',
  tableActions: (label) => `طاولة ${label}`,
  viewOrder: 'عرض / تعديل الطلب',
  checkoutAmount: (s) => `تحصيل · ${s}`,

  receipt: 'التذكرة',
  paid: 'مدفوع',
  ticketNo: (n) => `تذكرة رقم ${n}`,
  print: 'طباعة',
  customize: 'تخصيص',
  paidBy: 'الدفع',
  receiptSettings: 'تخصيص التذكرة',
  receiptName: 'الاسم المعروض',
  receiptHeader: 'أسطر تحت الاسم (العنوان، الهاتف…)',
  receiptFooter: 'رسالة الختام',
  receiptPreview: 'معاينة',
  locale: 'ar-DZ-u-nu-latn',
}

const dicts: Record<Lang, Dict> = { fr, ar }
const STORAGE_KEY = 'smile.lang'

function stored(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'ar' || v === 'fr') return v
  } catch {
    // Storage can be blocked (private mode, embedded previews); fall back to the default.
  }
  return 'fr'
}

let lang: Lang = stored()
const listeners = new Set<() => void>()

function applyToDocument() {
  document.documentElement.lang = lang
  document.documentElement.dir = dicts[lang].dir
}
applyToDocument()

export function setLang(next: Lang) {
  if (next === lang) return
  lang = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Not persisted, but the switch still applies for this visit.
  }
  applyToDocument()
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Strings for the current language, for code outside React (errors thrown by the data layer, formatting). */
export const tr = () => dicts[lang]

/** Current language and its strings; re-renders the component when the language changes. French is the default. */
export function useI18n() {
  const current = useSyncExternalStore(subscribe, () => lang)
  return { lang: current, t: dicts[current], setLang }
}
