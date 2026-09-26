'use strict';
module.exports = {
  async up(q, S) {
    await q.createTable('handwriting_word_attempts', {
      id:{type:S.INTEGER,primaryKey:true,autoIncrement:true}, action_id:{type:S.UUID,allowNull:false,unique:true},
      student_id:{type:S.INTEGER,allowNull:false,references:{model:'students',key:'sid'},onDelete:'CASCADE'}, word:{type:S.STRING(32),allowNull:false}, source_letter:{type:S.CHAR(1),allowNull:false},
      stage:{type:S.STRING(32),allowNull:false}, attempt_number:{type:S.INTEGER}, support_stage:{type:S.STRING(10)}, score:{type:S.FLOAT,allowNull:false}, threshold_used:{type:S.FLOAT,allowNull:false},
      passed:{type:S.BOOLEAN,allowNull:false}, completion_passed:{type:S.BOOLEAN,allowNull:false}, expected_letter_count:{type:S.INTEGER,allowNull:false}, covered_letter_count:{type:S.INTEGER,allowNull:false},
      strokes:{type:S.JSONB,allowNull:false}, normalized_features:{type:S.JSONB}, canvas_width:{type:S.INTEGER,allowNull:false}, canvas_height:{type:S.INTEGER,allowNull:false},
      capture_status:{type:S.STRING(16),allowNull:false,defaultValue:'complete'}, collection_mode:{type:S.BOOLEAN,allowNull:false,defaultValue:false}, word_score_version:{type:S.STRING(20),allowNull:false}, created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn('NOW')},
    });
    await q.addIndex('handwriting_word_attempts',['student_id','created_at'],{name:'handwriting_word_attempts_student_created_idx'});
    await q.createTable('handwriting_word_activity_progress', {
      id:{type:S.INTEGER,primaryKey:true,autoIncrement:true}, student_id:{type:S.INTEGER,allowNull:false,references:{model:'students',key:'sid'},onDelete:'CASCADE'}, word:{type:S.STRING(32),allowNull:false}, source_letter:{type:S.CHAR(1),allowNull:false},
      activity_status:{type:S.JSONB,allowNull:false,defaultValue:{}}, created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn('NOW')}, updated_at:{type:S.DATE,allowNull:false,defaultValue:S.fn('NOW')},
    });
    await q.addIndex('handwriting_word_activity_progress',['student_id','word'],{unique:true,name:'handwriting_word_progress_student_word_uq'});
  },
  async down(q) { await q.dropTable('handwriting_word_activity_progress'); await q.dropTable('handwriting_word_attempts'); },
};
