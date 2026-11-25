import { describe, expect, it } from 'vitest';
import {
  cleanLabelText,
  firstSentence,
  mapOpenFdaLabel,
  mapRelatedResponse,
  mapRxClassResponse,
  mapRxTermsResponse,
  mapRxcuiResponse,
  mapSpellingResponse,
  parseStrengthLabel,
  searchDrugs,
  splitRxTermsName,
  truncateAtSentence,
} from './drugLookup';

describe('parseStrengthLabel', () => {
  it.each([
    ['10 mg Tab', { dosage: '10 mg', form: 'Tablet' }],
    [' 2.5 mg Tab', { dosage: '2.5 mg', form: 'Tablet' }],
    ['500 mg/5mL Susp', { dosage: '500 mg/5mL', form: 'Suspension' }],
    ['125 mg/5ml Susp', { dosage: '125 mg/5mL', form: 'Suspension' }],
    ['250 mg Cap', { dosage: '250 mg', form: 'Capsule' }],
    ['1 mg/ml Sol', { dosage: '1 mg/mL', form: 'Solution' }],
    ['30 mg 24 HR XR Tab', { dosage: '30 mg', form: 'Extended-release tablet' }],
    ['20 mg XR Tab', { dosage: '20 mg', form: 'Extended-release tablet' }],
    ['10 mg DR Cap', { dosage: '10 mg', form: 'Delayed-release capsule' }],
    ['10 mg 30/70 Release 24 HR XR Cap', { dosage: '10 mg', form: 'Extended-release capsule' }],
    ['0.025 mg/hr 72 HR Patch', { dosage: '0.025 mg/hr', form: 'Patch' }],
    ['1% Cream', { dosage: '1%', form: 'Cream' }],
    ['0.1% Ointment', { dosage: '0.1%', form: 'Ointment' }],
    ['2.5-1,000 mg Tab', { dosage: '2.5-1,000 mg', form: 'Tablet' }],
    ['25 mg Suppository', { dosage: '25 mg', form: 'Suppository' }],
    ['100 unt/ml Pen Injector 3 ml', { dosage: '100 unt/mL', form: 'Pen injection' }],
    ['50 mcg/ml Injection 2 ml', { dosage: '50 mcg/mL', form: 'Injection' }],
    ['90 mcg/puff NDA020503 MDI', { dosage: '90 mcg/puff', form: 'Inhaler' }],
  ])('%s', (label, expected) => {
    expect(parseStrengthLabel(label)).toEqual(expected);
  });

  it('falls back to the raw label when there is no number or form', () => {
    expect(parseStrengthLabel('mixed Pack')).toEqual({ dosage: 'mixed Pack' });
    expect(parseStrengthLabel('10 Tab')).toEqual({ dosage: '10', form: 'Tablet' });
    expect(parseStrengthLabel('5 mg')).toEqual({ dosage: '5 mg' });
  });
});

// Recorded from clinicaltables.nlm.nih.gov (trimmed).
const RXTERMS_SAMPLE = [
  3,
  ['Lisinopril (Oral Pill)', 'hydroCHLOROthiazide/Lisinopril (Oral Pill)', 'Lisinopril (Oral Liquid)'],
  {
    STRENGTHS_AND_FORMS: [
      [' 2.5 mg Tab', ' 5 mg Tab', '10 mg Tab', '10 mg Tab'],
      ['12.5-10 mg Tab', '12.5-20 mg Tab'],
      ['1 mg/ml Sol'],
    ],
    RXCUIS: [['311353', '311354', '314076', '314076'], ['197885', '197886'], ['1806884']],
  },
  [['Lisinopril (Oral Pill)'], ['hydroCHLOROthiazide/Lisinopril (Oral Pill)'], ['Lisinopril (Oral Liquid)']],
];

describe('RxTerms mapper', () => {
  it('maps names, routes and strengths, trimming labels and deduping rxcuis', () => {
    const out = mapRxTermsResponse(RXTERMS_SAMPLE);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      name: 'Lisinopril',
      route: 'Oral Pill',
      strengths: [
        { label: '2.5 mg Tab', rxcui: '311353' },
        { label: '5 mg Tab', rxcui: '311354' },
        { label: '10 mg Tab', rxcui: '314076' },
      ],
    });
    expect(out[1].name).toBe('hydroCHLOROthiazide/Lisinopril');
    expect(out[2].strengths[0]).toEqual({ label: '1 mg/ml Sol', rxcui: '1806884' });
  });

  it('handles empty and malformed payloads', () => {
    expect(mapRxTermsResponse([0, [], {}, []])).toEqual([]);
    expect(mapRxTermsResponse(null)).toEqual([]);
    expect(mapRxTermsResponse('nope')).toEqual([]);
  });

  it('splits route suffixes', () => {
    expect(splitRxTermsName('Albuterol (Oral Pill)')).toEqual({ name: 'Albuterol', route: 'Oral Pill' });
    expect(splitRxTermsName('Plain')).toEqual({ name: 'Plain' });
  });

  it('searchDrugs short-circuits for short queries', async () => {
    expect(await searchDrugs(' a ')).toEqual([]);
  });
});

describe('RxNav mappers', () => {
  it('maps spelling suggestions', () => {
    expect(mapSpellingResponse({ suggestionGroup: { name: null, suggestionList: { suggestion: ['lisinopril'] } } })).toEqual([
      'lisinopril',
    ]);
    expect(mapSpellingResponse({ suggestionGroup: { name: null, suggestionList: {} } })).toEqual([]);
  });

  it('maps rxcui lookups', () => {
    expect(mapRxcuiResponse({ idGroup: { rxnormId: ['29046'] } })).toBe('29046');
    expect(mapRxcuiResponse({ idGroup: {} })).toBeUndefined();
  });

  it('maps related ingredients and brands', () => {
    const json = {
      relatedGroup: {
        rxcui: null,
        conceptGroup: [
          {
            tty: 'BN',
            conceptProperties: [
              { rxcui: '196472', name: 'Zestril', tty: 'BN' },
              { rxcui: '203644', name: 'Prinivil', tty: 'BN' },
              { rxcui: '1', name: 'zestril', tty: 'BN' },
            ],
          },
          { tty: 'IN', conceptProperties: [{ rxcui: '29046', name: 'lisinopril', tty: 'IN' }] },
        ],
      },
    };
    expect(mapRelatedResponse(json)).toEqual({
      ingredients: [{ rxcui: '29046', name: 'lisinopril' }],
      brands: ['Zestril', 'Prinivil'],
    });
    expect(mapRelatedResponse({ relatedGroup: { rxcui: null } })).toEqual({ ingredients: [], brands: [] });
  });

  it('maps and dedupes RxClass names by class type', () => {
    const item = (className: string, classType: string) => ({
      minConcept: { rxcui: '1' },
      rxclassMinConceptItem: { classId: 'x', className, classType },
    });
    const json = {
      rxclassDrugInfoList: {
        rxclassDrugInfo: [
          item('Angiotensin Converting Enzyme Inhibitor', 'EPC'),
          item('Angiotensin Converting Enzyme Inhibitor', 'EPC'),
          item('ACE inhibitors, plain', 'ATC1-4'),
        ],
      },
    };
    expect(mapRxClassResponse(json, ['EPC'])).toEqual(['Angiotensin Converting Enzyme Inhibitor']);
    expect(mapRxClassResponse(json, ['ATC1-4'])).toEqual(['ACE inhibitors, plain']);
    expect(mapRxClassResponse({}, ['EPC'])).toEqual([]);
  });
});

describe('label text helpers', () => {
  it('strips headings, cross references and whitespace', () => {
    expect(cleanLabelText(['1 INDICATIONS AND USAGE  Lisinopril is\n an ACE inhibitor (1.1) for hypertension.'])).toBe(
      'Lisinopril is an ACE inhibitor for hypertension.',
    );
    expect(cleanLabelText(['Purpose Pain reliever/fever reducer'])).toBe('Pain reliever/fever reducer');
    expect(cleanLabelText(['Warnings Allergy alert: Ibuprofen may cause a reaction.'])).toBe(
      'Allergy alert: Ibuprofen may cause a reaction.',
    );
    expect(cleanLabelText(undefined)).toBe('');
  });

  it('truncates at a sentence boundary with an ellipsis', () => {
    const sentence = 'This is a sentence about medicine. ';
    const long = sentence.repeat(100).trim();
    const out = truncateAtSentence(long, 1500);
    expect(out.length).toBeLessThanOrEqual(1503);
    expect(out.endsWith('. …')).toBe(true);
    expect(truncateAtSentence('short.', 1500)).toBe('short.');
    const noPunct = 'word '.repeat(600).trim();
    expect(truncateAtSentence(noPunct, 1500).endsWith('…')).toBe(true);
  });

  it('extracts a first sentence capped at 200 chars', () => {
    expect(firstSentence('Treats high blood pressure. Also other things.')).toBe('Treats high blood pressure.');
    expect(firstSentence('x '.repeat(300))!.length).toBeLessThanOrEqual(200);
    expect(firstSentence('   ')).toBeUndefined();
  });
});

describe('openFDA mapper', () => {
  const LISINOPRIL = {
    meta: { results: { total: 229 } },
    results: [
      {
        boxed_warning: ['WARNING: FETAL TOXICITY When pregnancy is detected, discontinue lisinopril as soon as possible.'],
        indications_and_usage: [
          '1 INDICATIONS AND USAGE Lisinopril is an angiotensin converting enzyme (ACE) inhibitor indicated for: Treatment of hypertension in adults (1.1) 1.1 Hypertension Lisinopril tablets are indicated for the treatment of hypertension.',
        ],
        dosage_and_administration: ['2 DOSAGE AND ADMINISTRATION 2.1 Hypertension The recommended initial dose is 10 mg once a day.'],
        warnings_and_cautions: ['5 WARNINGS AND PRECAUTIONS Angioedema: discontinue if it occurs.'],
        adverse_reactions: ['6 ADVERSE REACTIONS The most common adverse reactions are headache and dizziness.'],
        drug_interactions: ['7 DRUG INTERACTIONS Diuretics may increase the risk of hypotension.'],
        openfda: { generic_name: ['LISINOPRIL'], brand_name: ['Zestril'] },
      },
    ],
  };

  it('maps a prescription label', () => {
    const m = mapOpenFdaLabel(LISINOPRIL)!;
    expect(m.indications!.startsWith('Lisinopril is an angiotensin')).toBe(true);
    expect(m.indications).not.toMatch(/INDICATIONS AND USAGE/);
    expect(m.purpose!.startsWith('Lisinopril is an angiotensin converting enzyme (ACE) inhibitor indicated for:')).toBe(true);
    expect(m.purpose!.length).toBeLessThanOrEqual(200);
    expect(m.dosageAndAdministration).toBe('2.1 Hypertension The recommended initial dose is 10 mg once a day.');
    expect(m.warnings).toBe('Angioedema: discontinue if it occurs.');
    expect(m.boxedWarning).toMatch(/^WARNING: FETAL TOXICITY/);
    expect(m.sideEffects).toBe('The most common adverse reactions are headache and dizziness.');
    expect(m.interactions).toBe('Diuretics may increase the risk of hypotension.');
    expect(m.genericName).toBe('LISINOPRIL');
    expect(m.brandNames).toEqual(['Zestril']);
  });

  it('maps an OTC label using purpose and warnings', () => {
    const m = mapOpenFdaLabel({
      results: [
        {
          purpose: ['Purpose Pain reliever/fever reducer'],
          indications_and_usage: ['Uses temporarily relieves minor aches and pains.'],
          warnings: ['Warnings Allergy alert: Ibuprofen may cause a severe allergic reaction.'],
          openfda: {},
        },
      ],
    })!;
    expect(m.purpose).toBe('Pain reliever/fever reducer');
    expect(m.indications).toBe('temporarily relieves minor aches and pains.');
    expect(m.warnings).toBe('Allergy alert: Ibuprofen may cause a severe allergic reaction.');
    expect(m.boxedWarning).toBeUndefined();
    expect(m.brandNames).toEqual([]);
  });

  it('returns null for no results / errors', () => {
    expect(mapOpenFdaLabel({ error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(mapOpenFdaLabel({ results: [] })).toBeNull();
    expect(mapOpenFdaLabel(null)).toBeNull();
  });
});
