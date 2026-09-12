import test from 'node:test';
import assert from 'node:assert/strict';
import {beneficiaryPayload,beneficiaryValidation,initialBeneficiaryLines,normalizeBeneficiaryPhone} from '../lib/woocommerce-beneficiaries.mjs';

test('beneficiary phones normalize local, international and Arabic digits without accepting malformed identities',()=>{
  for(const value of ['0501234567','+966 50 123 4567','00966501234567','٠٥٠١٢٣٤٥٦٧','۰۵۰۱۲۳۴۵۶۷'])assert.equal(normalizeBeneficiaryPhone(value),'0501234567');
  for(const value of ['050123456','05012345678','foo0501234567','+201001234567','',null])assert.equal(normalizeBeneficiaryPhone(value),'');
});
test('group purchase never invents beneficiaries; saved seats and normal single-seat defaults are preserved',()=>{
  const ctx={contactId:'buyer',contactName:'المشتري',items:[{lineId:'a',title:'CAPM',quantity:2},{lineId:'b',title:'Excel',quantity:1}]};
  const lines=initialBeneficiaryLines(ctx);
  assert.deepEqual(lines[0].beneficiaries.map(b=>b.contactId),['','']);
  assert.equal(lines[1].beneficiaries[0].contactId,'buyer');
  assert.ok(beneficiaryValidation(lines));
  const saved=initialBeneficiaryLines({...ctx,beneficiaries:[{lineId:'a',seatNumber:2,contactId:'person',name:'متدرب',phone:'0501234567'}]});
  assert.equal(saved[0].beneficiaries[1].contactId,'person');
});
test('bounded seats, duplicate identities and minimal save payload',()=>{
  const one={lineId:'a',title:'CAPM',quantity:2,beneficiaries:[{mode:'existing',contactId:'buyer',name:'المشتري'},
    {mode:'new',name:' متدرب جديد ',phone:'+966501234567'}]};
  assert.equal(beneficiaryValidation([one]),'');
  assert.deepEqual(beneficiaryPayload([one]),[{lineId:'a',beneficiaries:[{contactId:'buyer'},{name:'متدرب جديد',phone:'0501234567'}]}]);
  assert.ok(beneficiaryValidation([{...one,beneficiaries:[one.beneficiaries[0],one.beneficiaries[0]]}]));
  assert.ok(beneficiaryValidation([{...one,quantity:1.5}]));
  assert.ok(beneficiaryValidation([{...one,quantity:101}]));
  assert.equal(initialBeneficiaryLines({items:[{lineId:'bad',quantity:1000000000}]} )[0].beneficiaries.length,0);
});
