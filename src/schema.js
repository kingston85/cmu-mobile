// CMU data model — one entry per synced table.
// Field types: text, textarea, number, date, select, ref (link to another table)
// The same keys become column headers in the CMU Google Sheet.

export const COUNTIES = [
  'Bomi', 'Bong', 'Gbarpolu', 'Grand Bassa', 'Grand Cape Mount', 'Grand Gedeh', 'Grand Kru',
  'Lofa', 'Margibi', 'Maryland', 'Montserrado', 'Nimba', 'River Cess', 'River Gee', 'Sinoe',
];

export const PORTS = [
  'Freeport of Monrovia', 'Port of Buchanan', 'Port of Greenville', 'Port of Harper',
  'Roberts International Airport', 'Ganta border', 'Bo Waterside border', 'Other',
];

export const TABLES = {
  importers: {
    label: 'Importers', singular: 'Importer', sheet: 'Importers', icon: '🏢',
    title: r => r.name, subtitle: r => [r.reg_no, r.county].filter(Boolean).join(' · '),
    duplicateKeys: ['name', 'reg_no'],
    fields: [
      { key: 'name', label: 'Company name', type: 'text', required: true },
      { key: 'reg_no', label: 'EPA registration no.', type: 'text' },
      { key: 'sector', label: 'Sector', type: 'select', options: ['Mining', 'Agriculture', 'Manufacturing', 'Petroleum', 'Health', 'Water treatment', 'Construction', 'Trading', 'Other'] },
      { key: 'contact_person', label: 'Contact person', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text', inputMode: 'tel' },
      { key: 'email', label: 'Email', type: 'text', inputMode: 'email' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'county', label: 'County', type: 'select', options: COUNTIES },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Suspended', 'Inactive'] },
    ],
  },
  chemicals: {
    label: 'Chemicals', singular: 'Chemical', sheet: 'Chemicals', icon: '⚗️',
    title: r => r.name, subtitle: r => [r.cas_no && `CAS ${r.cas_no}`, r.category].filter(Boolean).join(' · '),
    duplicateKeys: ['name', 'cas_no'],
    fields: [
      { key: 'name', label: 'Chemical name', type: 'text', required: true },
      { key: 'cas_no', label: 'CAS number', type: 'text' },
      { key: 'un_no', label: 'UN number', type: 'text' },
      { key: 'category', label: 'EPA fee category', type: 'select', options: ['Category I', 'Category II', 'Category III', 'Category IV', 'Restricted', 'Banned'] },
      { key: 'hazard_class', label: 'Hazard class', type: 'select', options: ['1 Explosive', '2 Gas', '3 Flammable liquid', '4 Flammable solid', '5 Oxidiser', '6 Toxic', '7 Radioactive', '8 Corrosive', '9 Miscellaneous', 'Non-hazardous'] },
      { key: 'hmis_health', label: 'HMIS health (0–4)', type: 'number' },
      { key: 'use', label: 'Main use', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  permits: {
    label: 'Permits', singular: 'Permit', sheet: 'Permits', icon: '📄',
    title: r => r.permit_no, subtitle: (r, look) => [look('importers', r.importer_id), r.expiry_date && `expires ${r.expiry_date}`].filter(Boolean).join(' · '),
    duplicateKeys: ['permit_no'],
    fields: [
      { key: 'permit_no', label: 'Permit no.', type: 'text', required: true },
      { key: 'importer_id', label: 'Importer', type: 'ref', ref: 'importers', required: true },
      { key: 'permit_type', label: 'Type', type: 'select', options: ['Import permit', 'Storage licence', 'Transport permit', 'Use permit', 'Export permit'] },
      { key: 'issue_date', label: 'Issue date', type: 'date' },
      { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Pending', 'Approved', 'Rejected', 'Revoked'] },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  consignments: {
    label: 'Consignments', singular: 'Consignment', sheet: 'Consignments', icon: '📦',
    title: (r, look) => look('chemicals', r.chemical_id) || 'Consignment',
    subtitle: (r, look) => [look('importers', r.importer_id), r.quantity && `${r.quantity} ${r.unit || ''}`, r.arrival_date].filter(Boolean).join(' · '),
    duplicateKeys: ['bill_of_lading'],
    fields: [
      { key: 'importer_id', label: 'Importer', type: 'ref', ref: 'importers', required: true },
      { key: 'chemical_id', label: 'Chemical', type: 'ref', ref: 'chemicals', required: true },
      { key: 'permit_id', label: 'Permit', type: 'ref', ref: 'permits' },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'unit', label: 'Unit', type: 'select', options: ['kg', 'MT', 'L', 'drums', 'bags', 'cylinders'] },
      { key: 'port', label: 'Port of entry', type: 'select', options: PORTS },
      { key: 'bill_of_lading', label: 'Bill of lading / AWB no.', type: 'text' },
      { key: 'arrival_date', label: 'Arrival date', type: 'date' },
      { key: 'fee_usd', label: 'Assessed fee (US$)', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: ['Declared', 'Assessed', 'Paid', 'Released', 'Detained'] },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  inspections: {
    label: 'Inspections', singular: 'Inspection', sheet: 'Inspections', icon: '🔍',
    title: r => r.site_name, subtitle: (r, look) => [look('importers', r.importer_id), r.inspection_date, r.compliance].filter(Boolean).join(' · '),
    duplicateKeys: [],
    hasGps: true, hasPhotos: true,
    fields: [
      { key: 'site_name', label: 'Site / facility', type: 'text', required: true },
      { key: 'importer_id', label: 'Importer', type: 'ref', ref: 'importers' },
      { key: 'consignment_id', label: 'Consignment', type: 'ref', ref: 'consignments' },
      { key: 'inspection_type', label: 'Type', type: 'select', options: ['Port clearance', 'Warehouse / storage', 'Mine site', 'Routine', 'Complaint', 'Follow-up'] },
      { key: 'inspection_date', label: 'Date', type: 'date', required: true, defaultToday: true },
      { key: 'county', label: 'County', type: 'select', options: COUNTIES },
      { key: 'compliance', label: 'Compliance', type: 'select', options: ['Compliant', 'Minor issues', 'Non-compliant'] },
      { key: 'findings', label: 'Findings', type: 'textarea' },
      { key: 'actions', label: 'Actions required', type: 'textarea' },
      { key: 'follow_up_date', label: 'Follow-up date', type: 'date' },
    ],
  },
};

export const TABLE_KEYS = Object.keys(TABLES);
export const SYSTEM_FIELDS = ['id', 'version', 'updated_at', 'updated_by', 'deleted'];
