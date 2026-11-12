using FraudService from './fraud-service';

// Fiori Elements review queue.
annotate FraudService.Alerts with @(
  UI.HeaderInfo: { TypeName: 'Review item', TypeNamePlural: 'Exception Review', Title: { Value: ruleId }, Description: { Value: title } },
  UI.SelectionFields: [ tier, decision, ruleId ],
  UI.LineItem: [
    { Value: ruleId, Label: 'Rule' },
    { Value: title, Label: 'Check' },
    { Value: tier, Label: 'Tier' },
    { Value: text, Label: 'Reason' },
    { Value: decision, Label: 'Decision' },
    { Value: createdAt, Label: 'Raised' }
  ],
  UI.Identification: [ { $Type: 'UI.DataFieldForAction', Action: 'FraudService.decide', Label: 'Decide' } ],
  UI.Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Details', Target: '@UI.FieldGroup#Details' } ],
  UI.FieldGroup #Details: { Data: [
    { Value: ruleId, Label: 'Rule' },
    { Value: tier, Label: 'Tier' },
    { Value: text, Label: 'Reason' },
    { Value: decision, Label: 'Decision' },
    { Value: comment, Label: 'Comment' },
    { Value: decidedBy, Label: 'Decided by' },
    { Value: decidedAt, Label: 'Decided at' }
  ] }
);

// Fiori Elements check history.
annotate FraudService.Checks with @(
  UI.HeaderInfo: { TypeName: 'Invoice check', TypeNamePlural: 'Verification History', Title: { Value: invoiceNo }, Description: { Value: supplierName } },
  UI.SelectionFields: [ status, supplierName, source ],
  UI.LineItem: [
    { Value: invoiceNo, Label: 'Invoice no' },
    { Value: supplierName, Label: 'Supplier' },
    { Value: invoiceDate, Label: 'Invoice date' },
    { Value: total, Label: 'Total (INR)' },
    { Value: status, Label: 'Status' },
    { Value: source, Label: 'Source' },
    { Value: createdAt, Label: 'Checked at' }
  ],
  UI.Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Rule results', Target: 'results/@UI.LineItem' } ]
);

annotate FraudService.CheckResults with @(
  UI.LineItem: [
    { Value: ruleId, Label: 'Rule' },
    { Value: title, Label: 'Check' },
    { Value: tier, Label: 'Tier' },
    { Value: text, Label: 'Reason' }
  ]
);
